import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../api/auth_api.dart';
import '../models/user.dart';

/// 全局登录状态
class AuthState extends ChangeNotifier {
  User? _user;
  bool _initialized = false;
  bool _loading = false;

  User? get user => _user;
  bool get isLoggedIn => _user != null;
  bool get isAdmin => _user?.isAdmin ?? false;
  bool get isInitialized => _initialized;
  bool get isLoading => _loading;

  AuthState() {
    ApiClient.instance.setOnUnauthorized(() {
      _user = null;
      notifyListeners();
    });
  }

  /// 启动时恢复登录态
  Future<void> restore() async {
    if (_initialized) return;
    try {
      _user = await AuthApi.me();
    } catch (_) {
      _user = null;
    }
    _initialized = true;
    notifyListeners();
  }

  /// 登录
  Future<void> login(String username, String password) async {
    _loading = true;
    notifyListeners();
    try {
      final token = await AuthApi.login(username, password);
      await ApiClient.instance.saveToken(token);
      _user = await AuthApi.me();
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  /// 登出
  Future<void> logout() async {
    await AuthApi.logout();
    _user = null;
    notifyListeners();
  }

  /// 更新本地用户信息
  void refreshUser(User user) {
    _user = user;
    notifyListeners();
  }
}
