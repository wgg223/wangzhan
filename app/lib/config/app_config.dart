/// 全局配置：服务器地址。
///
/// 部署后请把 [serverBaseUrl] 改为你的服务器地址，
/// 例如 https://your-server.com。开发阶段可用局域网 IP。
class AppConfig {
  AppConfig._();

  /// 服务器根地址（不带末尾斜杠）
  static const String serverBaseUrl = 'https://dalaowang233.top';

  /// API 命名空间
  static const String apiPrefix = '/api/v1';

  /// 拼接完整的 API 路径
  static String api(String path) => '$apiPrefix$path';

  /// 拼接静态资源（图片）完整地址
  static String asset(String path) {
    if (path.isEmpty) return '';
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    if (path.startsWith('/')) return '$serverBaseUrl$path';
    return '$serverBaseUrl/$path';
  }
}
