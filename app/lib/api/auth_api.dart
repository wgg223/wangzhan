import '../config/app_config.dart';
import '../models/user.dart';
import 'api_client.dart';

/// 认证相关接口
class AuthApi {
  static final ApiClient _client = ApiClient.instance;

  /// 登录，成功返回 token
  static Future<String> login(String username, String password) async {
    final data = await _client.post(AppConfig.api('/auth/login'), data: {
      'username': username,
      'password': password,
    });
    final token = data is Map ? data['token']?.toString() : null;
    if (token == null || token.isEmpty) {
      throw ApiException('登录失败：服务器未返回令牌');
    }
    return token;
  }

  /// 获取用户协议与隐私政策（登录/注册强制同意弹窗）
  static Future<Map<String, String>> agreements() async {
    final data = await _client.get(AppConfig.api('/auth/agreements'));
    final map = data is Map ? data : const {};
    return {
      'user_agreement': map['user_agreement']?.toString() ?? '',
      'privacy_policy': map['privacy_policy']?.toString() ?? '',
    };
  }

  /// 获取图形验证码，返回 (captcha_id, svg)
  static Future<(String, String)> captcha() async {
    final data = await _client.get(AppConfig.api('/auth/captcha'));
    final map = data is Map ? data : const {};
    return (map['captcha_id']?.toString() ?? '', map['svg']?.toString() ?? '');
  }

  /// 注册
  static Future<void> register({
    required String username,
    required String password,
    String? nickname,
    String? email,
    String? captchaId,
    String? captcha,
  }) async {
    await _client.post(AppConfig.api('/auth/register'), data: {
      'username': username,
      'password': password,
      'nickname': nickname ?? '',
      'email': email ?? '',
      'captcha_id': captchaId ?? '',
      'captcha': captcha ?? '',
    });
  }

  /// 获取当前用户信息
  static Future<User> me() async {
    final data = await _client.get(AppConfig.api('/auth/me'));
    return User.fromJson((data as Map)['user'] as Map<String, dynamic>);
  }

  /// 登出
  static Future<void> logout() async {
    try {
      await _client.post(AppConfig.api('/auth/logout'));
    } catch (_) {
      // 忽略登出网络错误
    }
    await _client.clearToken();
  }

  /// 更新个人资料
  static Future<void> updateProfile({
    String? nickname,
    String? bio,
    String? avatar,
  }) async {
    await _client.put(AppConfig.api('/auth/profile'), data: {
      if (nickname != null) 'nickname': nickname,
      if (bio != null) 'bio': bio,
      if (avatar != null) 'avatar': avatar,
    });
  }

  /// 修改密码
  static Future<void> changePassword(String oldPassword, String newPassword) async {
    await _client.put(AppConfig.api('/auth/password'), data: {
      'old_password': oldPassword,
      'new_password': newPassword,
    });
  }
}
