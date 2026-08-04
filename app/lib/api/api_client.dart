import 'package:dio/dio.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/app_config.dart';

/// API 统一客户端：注入 token、统一错误处理、401 自动登出。
class ApiClient {
  /// token 读取来源（测试可注入；默认从 SharedPreferences 读取）
  final Future<String?> Function() _tokenProvider;

  ApiClient._({Future<String?> Function()? tokenProvider, Dio? dio})
      : _tokenProvider = tokenProvider ?? _readTokenFromPrefs {
    _dio = dio ?? Dio(BaseOptions(
      baseUrl: AppConfig.serverBaseUrl,
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 30),
      contentType: Headers.jsonContentType,
    ));
    _dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) async {
        final token = await _tokenProvider();
        if (token != null && token.isNotEmpty) {
          options.headers['Authorization'] = 'Bearer $token';
        }
        handler.next(options);
      },
      onError: (e, handler) {
        if (e.response?.statusCode == 401) {
          _onUnauthorized?.call();
        }
        handler.next(e);
      },
    ));
  }

  /// 供测试使用的独立实例：可注入 token provider 与 dio，默认行为与单例一致。
  ApiClient.test({Future<String?> Function()? tokenProvider, Dio? dio})
      : this._(tokenProvider: tokenProvider, dio: dio);

  static final ApiClient instance = ApiClient._();

  late final Dio _dio;
  static const _tokenKey = 'auth_token';
  void Function()? _onUnauthorized;
  static String? _cachedToken;

  /// 设置 401 时的全局回调（用于登出）
  void setOnUnauthorized(void Function() callback) {
    _onUnauthorized = callback;
  }

  /// 首次读取后缓存到内存，登出（[clearToken]）时失效
  static Future<String?> _readTokenFromPrefs() async {
    if (_cachedToken != null) return _cachedToken;
    final prefs = await SharedPreferences.getInstance();
    _cachedToken = prefs.getString(_tokenKey);
    return _cachedToken;
  }

  Future<void> saveToken(String token) async {
    _cachedToken = token;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, token);
  }

  Future<void> clearToken() async {
    _cachedToken = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
  }

  /// GET 请求，返回解码后的 JSON
  Future<dynamic> get(String path, {Map<String, dynamic>? query}) =>
      _request('GET', path, query: query);

  /// POST 请求
  Future<dynamic> post(String path, {dynamic data}) =>
      _request('POST', path, body: data);

  /// PUT 请求
  Future<dynamic> put(String path, {dynamic data}) =>
      _request('PUT', path, body: data);

  /// PATCH 请求
  Future<dynamic> patch(String path, {dynamic data}) =>
      _request('PATCH', path, body: data);

  /// DELETE 请求
  Future<dynamic> delete(String path, {Map<String, dynamic>? query}) =>
      _request('DELETE', path, query: query);

  /// multipart 文件上传（filePaths 为本地文件路径列表）
  Future<dynamic> upload(String path, List<String> filePaths,
      {Map<String, dynamic>? fields}) async {
    final form = FormData();
    fields?.forEach((k, v) => form.fields.add(MapEntry(k, v.toString())));
    for (final p in filePaths) {
      form.files.add(MapEntry('files', await MultipartFile.fromFile(p)));
    }
    return _request('POST', path, body: form,
        options: Options(contentType: 'multipart/form-data'));
  }

  /// 统一请求入口：method + path + 可选 body/query/options
  Future<T> _request<T>(
    String method,
    String path, {
    dynamic body,
    Map<String, dynamic>? query,
    Options? options,
    T Function(dynamic data)? decoder,
  }) async {
    try {
      final res = await _dio.request(
        path,
        data: body,
        queryParameters: query,
        options: options ?? Options(method: method),
      );
      final data = res.data;
      return decoder != null ? decoder(data) : data as T;
    } on DioException catch (e) {
      throw _toApiError(e);
    }
  }

  /// 从 DioException 提取服务器返回的错误信息
  ApiException _toApiError(DioException e) {
    final data = e.response?.data;
    String message = '网络错误，请检查连接';
    if (data is Map && data['error'] != null) {
      message = data['error'].toString();
    } else if (data is Map && data['message'] != null) {
      message = data['message'].toString();
    } else if (e.response?.statusCode != null) {
      message = '请求失败 (${e.response?.statusCode})';
    }
    return ApiException(message, statusCode: e.response?.statusCode);
  }
}

/// API 异常（带服务器返回的中文错误信息）
class ApiException implements Exception {
  ApiException(this.message, {this.statusCode});
  final String message;
  final int? statusCode;

  @override
  String toString() => message;
}
