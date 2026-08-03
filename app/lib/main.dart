import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'screens/auth/login_screen.dart';
import 'screens/main_shell.dart';
import 'state/auth_state.dart';
import 'state/theme_state.dart';
import 'theme/app_theme.dart';

void main() {
  runApp(const MiApp());
}

class MiApp extends StatelessWidget {
  const MiApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => AuthState()..restore()),
        ChangeNotifierProvider(create: (_) => ThemeState()..load()),
      ],
      child: Consumer<ThemeState>(
        builder: (context, ts, _) {
          final transparentBg = ts.backgroundDecoration != null;
          return MaterialApp(
            title: '网站客户端',
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light(fontFamily: ts.fontFamily, transparentBg: transparentBg),
            darkTheme: AppTheme.dark(fontFamily: ts.fontFamily, transparentBg: transparentBg),
            themeMode: ts.flutterMode,
            builder: (context, child) =>
                _ThemeBackground(decoration: ts.backgroundDecoration, child: child ?? const SizedBox.shrink()),
            home: const RootGate(),
          );
        },
      ),
    );
  }
}

/// 自定义背景包装：在应用内容下层渲染渐变/图片背景
class _ThemeBackground extends StatelessWidget {
  const _ThemeBackground({required this.decoration, required this.child});

  final BoxDecoration? decoration;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (decoration == null) return child;
    return Stack(
      fit: StackFit.expand,
      children: [
        DecoratedBox(decoration: decoration!),
        child,
      ],
    );
  }
}

/// 根据登录态选择入口页面
class RootGate extends StatelessWidget {
  const RootGate({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    if (!auth.isInitialized) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    return auth.isLoggedIn ? const MainShell() : const LoginScreen();
  }
}
