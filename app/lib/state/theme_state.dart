import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 主题外观模式
enum AppThemeMode { system, light, dark }

/// 字体
enum AppFont { system, serif, mono, sans }

/// 背景
enum AppBackground { none, soft, dream, night, custom }

/// 主题设置（字体 / 背景 / 亮暗），SharedPreferences 持久化
class ThemeState extends ChangeNotifier {
  static const _key = 'app_theme_settings';

  AppThemeMode mode = AppThemeMode.system;
  AppFont font = AppFont.system;
  AppBackground background = AppBackground.none;
  String customBgUrl = '';

  /// 加载持久化的主题设置
  Future<void> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_key);
      if (raw == null || raw.isEmpty) return;
      final map = _decodeMap(raw);
      mode = _parseMode(map['mode']);
      font = _parseFont(map['font']);
      background = _parseBackground(map['background']);
      customBgUrl = map['customBgUrl']?.toString() ?? '';
      notifyListeners();
    } catch (_) {/* ignore */}
  }

  Future<void> _save() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_key, jsonEncode({
        'mode': mode.name,
        'font': font.name,
        'background': background.name,
        'customBgUrl': customBgUrl,
      }));
    } catch (_) {/* ignore */}
  }

  /// 更新状态并持久化
  Future<void> _update(void Function() apply) async {
    apply();
    notifyListeners();
    await _save();
  }

  Future<void> setMode(AppThemeMode value) => _update(() => mode = value);

  Future<void> setFont(AppFont value) => _update(() => font = value);

  Future<void> setBackground(AppBackground value) =>
      _update(() => background = value);

  Future<void> setCustomBgUrl(String url) =>
      _update(() => customBgUrl = url.trim());

  /// Flutter 亮暗模式
  ThemeMode get flutterMode => switch (mode) {
        AppThemeMode.system => ThemeMode.system,
        AppThemeMode.light => ThemeMode.light,
        AppThemeMode.dark => ThemeMode.dark,
      };

  /// 当前字体族（null 表示系统默认）
  String? get fontFamily => switch (font) {
        AppFont.system => null,
        AppFont.serif => 'serif',
        AppFont.mono => 'monospace',
        AppFont.sans => 'sans-serif',
      };

  /// 背景装饰（渐变或图片），null 表示无自定义背景
  BoxDecoration? get backgroundDecoration {
    switch (background) {
      case AppBackground.soft:
        return const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [Color(0xFFEEF2FF), Color(0xFFFDF2F8), Color(0xFFFFF7ED)],
          ),
        );
      case AppBackground.dream:
        return const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [Color(0xFFEDE9FE), Color(0xFFDBEAFE), Color(0xFFF0FDFA)],
          ),
        );
      case AppBackground.night:
        return const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Color(0xFF1E293B), Color(0xFF0F172A)],
          ),
        );
      case AppBackground.custom:
        if (customBgUrl.isNotEmpty) {
          return BoxDecoration(
            image: DecorationImage(
              image: NetworkImage(customBgUrl),
              fit: BoxFit.cover,
            ),
          );
        }
        return null;
      case AppBackground.none:
        return null;
    }
  }

  static Map<String, dynamic> _decodeMap(String raw) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map) {
        return decoded.map((k, v) => MapEntry(k.toString(), v));
      }
    } catch (_) {/* ignore */}
    return {};
  }

  static AppThemeMode _parseMode(Object? v) =>
      AppThemeMode.values.asNameMap()[v] ?? AppThemeMode.system;

  static AppFont _parseFont(Object? v) =>
      AppFont.values.asNameMap()[v] ?? AppFont.system;

  static AppBackground _parseBackground(Object? v) =>
      AppBackground.values.asNameMap()[v] ?? AppBackground.none;
}
