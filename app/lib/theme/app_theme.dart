import 'package:flutter/material.dart';

/// 应用主题：浅色 + 深色，配色贴合网站风格
class AppTheme {
  static const Color primary = Color(0xFF2563EB);
  static const Color accent = Color(0xFF7C3AED);
  static const Color background = Color(0xFFF8FAFC);
  static const Color card = Colors.white;

  static ThemeData light({String? fontFamily, bool transparentBg = false}) {
    final base = ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(seedColor: primary, brightness: Brightness.light),
      scaffoldBackgroundColor: transparentBg ? Colors.transparent : background,
      fontFamily: fontFamily,
      appBarTheme: const AppBarTheme(
        backgroundColor: background,
        elevation: 0,
        centerTitle: true,
        titleTextStyle: TextStyle(color: Colors.black87, fontSize: 18, fontWeight: FontWeight.w600),
      ),
      cardTheme: const CardThemeData(color: card, elevation: 1),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: Colors.grey.shade300)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: Colors.grey.shade300)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: primary, width: 1.5)),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          minimumSize: const Size.fromHeight(46),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        ),
      ),
    );
    return transparentBg ? base.copyWith(appBarTheme: const AppBarTheme(backgroundColor: Colors.transparent, elevation: 0, centerTitle: true, titleTextStyle: TextStyle(color: Colors.black87, fontSize: 18, fontWeight: FontWeight.w600))) : base;
  }

  static ThemeData dark({String? fontFamily, bool transparentBg = false}) {
    final base = ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(seedColor: primary, brightness: Brightness.dark),
      scaffoldBackgroundColor: transparentBg ? Colors.transparent : const Color(0xFF111827),
      fontFamily: fontFamily,
      appBarTheme: const AppBarTheme(
        backgroundColor: Color(0xFF111827),
        elevation: 0,
        centerTitle: true,
      ),
      cardTheme: const CardThemeData(elevation: 1),
    );
    return transparentBg ? base.copyWith(appBarTheme: const AppBarTheme(backgroundColor: Colors.transparent, elevation: 0, centerTitle: true)) : base;
  }
}
