import 'package:dio/dio.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/app_config.dart';

/// API 统一客户端：注入 token、统一错误处理、401 自动登出。
class ApiClient {
  ApiClient._internal() {
    _dio = Dio(BaseOptions(
      baseUrl: AppConfig.serverBaseUrl,
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 30),
      contentType: Headers.jsonContentType,
    ));
    _dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) async {
        final token = await _readToken();
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

  static final ApiClient instance = ApiClient._internal();

  late final Dio _dio;
  static const _tokenKey = 'auth_token';
  void Function()? _onUnauthorized;

  /// 设置 401 时的全局回调（用于登出）
  void setOnUnauthorized(void Function() callback) {
    _onUnauthorized = callback;
  }

  Future<String?> _readToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_tokenKey);
  }

  Future<void> saveToken(String token) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, token);
  }

  Future<void> clearToken() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
  }

  /// GET 请求，返回解码后的 JSON
  Future<dynamic> get(String path, {Map<String, dynamic>? query}) async {
    try {
      final res = await _dio.get(path, queryParameters: query);
      return res.data;
    } on DioException catch (e) {
      throw _toApiError(e);
    }
  }

  /// POST 请求
  Future<dynamic> post(String path, {dynamic data}) async {
    try {
      final res = await _dio.post(path, data: data);
      return res.data;
    } on DioException catch (e) {
      throw _toApiError(e);
    }
  }

  /// PUT 请求
  Future<dynamic> put(String path, {dynamic data}) async {
    try {
      final res = await _dio.put(path, data: data);
      return res.data;
    } on DioException catch (e) {
      throw _toApiError(e);
    }
  }

  /// PATCH 请求
  Future<dynamic> patch(String path, {dynamic data}) async {
    try {
      final res = await _dio.patch(path, data: data);
      return res.data;
    } on DioException catch (e) {
      throw _toApiError(e);
    }
  }

  /// DELETE 请求
  Future<dynamic> delete(String path, {Map<String, dynamic>? query}) async {
    try {
      final res = await _dio.delete(path, queryParameters: query);
      return res.data;
    } on DioException catch (e) {
      throw _toApiError(e);
    }
  }

  /// multipart 文件上传（filePaths 为本地文件路径列表）
  Future<dynamic> upload(String path, List<String> filePaths,
      {Map<String, dynamic>? fields}) async {
    try {
      final form = FormData();
      fields?.forEach((k, v) => form.fields.add(MapEntry(k, v.toString())));
      for (final p in filePaths) {
        form.files.add(MapEntry('files', await MultipartFile.fromFile(p)));
      }
      final res = await _dio.post(
        path,
        data: form,
        options: Options(contentType: 'multipart/form-data'),
      );
      return res.data;
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
