import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mi_app/api/api_client.dart';

/// 可编程的假适配器：按预设返回成功响应或抛出指定 DioException，
/// 并记录最近一次请求的 RequestOptions 供断言。
class _FakeAdapter implements HttpClientAdapter {
  _FakeAdapter({this.statusCode, this.body, this.error});

  int? statusCode;
  String? body;
  DioException? error;
  RequestOptions? lastOptions;

  @override
  Future<ResponseBody> fetch(RequestOptions options,
      Stream<Uint8List>? requestStream, Future<void>? cancelFuture) async {
    lastOptions = options;
    if (error != null) throw error!;
    return ResponseBody.fromString(
      body ?? '',
      statusCode ?? 200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

Dio _dio(_FakeAdapter adapter) => Dio(BaseOptions(baseUrl: 'https://example.com'))
  ..httpClientAdapter = adapter;

DioException _badResponse(int statusCode, Map<String, dynamic> data) =>
    DioException(
      requestOptions: RequestOptions(path: '/x'),
      response: Response(
        requestOptions: RequestOptions(path: '/x'),
        statusCode: statusCode,
        data: data,
      ),
      type: DioExceptionType.badResponse,
    );

void main() {
  group('DioException → ApiException 错误映射', () {
    test('服务器返回 error 字段时优先取 error', () async {
      final api = ApiClient.test(
        tokenProvider: () async => null,
        dio: _dio(_FakeAdapter(
          error: _badResponse(400, {'error': '用户名已存在'}),
        )),
      );
      await expectLater(
        api.get('/x'),
        throwsA(isA<ApiException>()
            .having((e) => e.message, 'message', '用户名已存在')
            .having((e) => e.statusCode, 'statusCode', 400)),
      );
    });

    test('无 error 字段时取 message 字段', () async {
      final api = ApiClient.test(
        tokenProvider: () async => null,
        dio: _dio(_FakeAdapter(
          error: _badResponse(403, {'message': '您没有此操作的权限'}),
        )),
      );
      await expectLater(
        api.get('/x'),
        throwsA(isA<ApiException>()
            .having((e) => e.message, 'message', '您没有此操作的权限')
            .having((e) => e.statusCode, 'statusCode', 403)),
      );
    });

    test('服务器响应体为空时用状态码兜底', () async {
      final api = ApiClient.test(
        tokenProvider: () async => null,
        dio: _dio(_FakeAdapter(error: _badResponse(500, {}))),
      );
      await expectLater(
        api.get('/x'),
        throwsA(isA<ApiException>()
            .having((e) => e.message, 'message', '请求失败 (500)')
            .having((e) => e.statusCode, 'statusCode', 500)),
      );
    });

    test('网络错误兜底为通用提示', () async {
      final api = ApiClient.test(
        tokenProvider: () async => null,
        dio: _dio(_FakeAdapter(
          error: DioException(
            requestOptions: RequestOptions(path: '/x'),
            type: DioExceptionType.connectionError,
          ),
        )),
      );
      await expectLater(
        api.get('/x'),
        throwsA(isA<ApiException>()
            .having((e) => e.message, 'message', '网络错误，请检查连接')
            .having((e) => e.statusCode, 'statusCode', isNull)),
      );
    });
  });

  group('token 注入', () {
    test('token provider 返回值注入 Authorization 头', () async {
      final adapter = _FakeAdapter(statusCode: 200, body: '{}');
      final api = ApiClient.test(
        tokenProvider: () async => 'test-token',
        dio: _dio(adapter),
      );
      await api.get('/x');
      expect(adapter.lastOptions, isNotNull);
      expect(adapter.lastOptions!.headers['Authorization'], 'Bearer test-token');
    });

    test('token 为空时不注入 Authorization 头', () async {
      final adapter = _FakeAdapter(statusCode: 200, body: '{}');
      final api = ApiClient.test(
        tokenProvider: () async => null,
        dio: _dio(adapter),
      );
      await api.get('/x');
      expect(adapter.lastOptions, isNotNull);
      expect(adapter.lastOptions!.headers.containsKey('Authorization'), isFalse);
    });
  });

  group('成功响应', () {
    test('返回解码后的 JSON', () async {
      final api = ApiClient.test(
        tokenProvider: () async => null,
        dio: _dio(_FakeAdapter(statusCode: 200, body: '{"ok":true}')),
      );
      final data = await api.get('/x');
      expect(data, {'ok': true});
    });
  });
}
