import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../api/api_client.dart';
import '../../api/auth_api.dart';
import '../../state/auth_state.dart';
import 'register_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _username = TextEditingController();
  final _password = TextEditingController();
  bool _obscure = true;
  String? _error;

  /// 是否已同意《用户协议》和《隐私政策》（同意后才能登录）
  bool _agreed = false;

  /// 是否正在拉取协议
  bool _loadingAgreements = true;

  /// 默认协议兜底文本（接口不可用时使用）
  static const _fallbackAgreement =
      '1. 您应遵守国家法律法规，不得利用本平台从事违法违规活动。\n'
      '2. 请妥善保管您的账号密码，因账号保管不善造成的损失由您自行承担。\n'
      '3. 您在本平台发布的合法内容，版权归您所有，平台仅提供服务。';
  static const _fallbackPrivacy =
      '1. 我们仅收集为您提供服务所必需的信息（账号、邮箱等）。\n'
      '2. 我们不会向第三方出售您的个人信息。\n'
      '3. 您可随时申请注销账号并删除个人信息。';

  @override
  void initState() {
    super.initState();
    _loadAgreementsAndShow();
  }

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  /// 拉取协议内容并依次弹出《用户协议》《隐私政策》
  Future<void> _loadAgreementsAndShow() async {
    Map<String, String> agreements;
    try {
      agreements = await AuthApi.agreements();
    } catch (_) {
      agreements = {
        'user_agreement': _fallbackAgreement,
        'privacy_policy': _fallbackPrivacy,
      };
    }
    if (!mounted) return;
    setState(() => _loadingAgreements = false);
    _showAgreementDialog(
      title: '用户协议',
      content: agreements['user_agreement'] ?? _fallbackAgreement,
      onAgree: () {
        _showAgreementDialog(
          title: '隐私政策',
          content: agreements['privacy_policy'] ?? _fallbackPrivacy,
          onAgree: () {
            if (mounted) setState(() => _agreed = true);
          },
        );
      },
    );
  }

  /// 强制协议弹窗：只能同意（关闭即不同意，登录保持禁用）
  void _showAgreementDialog({
    required String title,
    required String content,
    required VoidCallback onAgree,
  }) {
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: SingleChildScrollView(
          child: Text(_stripHtml(content), style: const TextStyle(height: 1.7)),
        ),
        actions: [
          FilledButton(
            onPressed: () {
              Navigator.pop(ctx);
              onAgree();
            },
            child: const Text('同意并继续'),
          ),
        ],
      ),
    );
  }

  /// 移除 HTML 标签，纯文本展示协议内容
  static String _stripHtml(String html) {
    final text = html.replaceAll(RegExp(r'<[^>]*>'), '');
    return text
        .replaceAll('&nbsp;', ' ')
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .trim();
  }

  Future<void> _login() async {
    if (!_agreed) {
      setState(() => _error = '请先阅读并同意《用户协议》和《隐私政策》');
      _loadAgreementsAndShow();
      return;
    }
    final username = _username.text.trim();
    final password = _password.text;
    if (username.isEmpty || password.isEmpty) {
      setState(() => _error = '请输入用户名和密码');
      return;
    }
    setState(() => _error = null);
    try {
      await context.read<AuthState>().login(username, password);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = '网络错误，请检查连接');
    }
  }

  @override
  Widget build(BuildContext context) {
    final loading = context.watch<AuthState>().isLoading;
    final canLogin = _agreed && !_loadingAgreements;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // 品牌标识区
                Container(
                  width: 88,
                  height: 88,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [Color(0xFF2563EB), Color(0xFF7C3AED)],
                    ),
                    borderRadius: BorderRadius.circular(24),
                    boxShadow: [
                      BoxShadow(
                        color: const Color(0xFF2563EB).withValues(alpha: 0.3),
                        blurRadius: 20,
                        offset: const Offset(0, 8),
                      ),
                    ],
                  ),
                  child: const Icon(Icons.public, size: 44, color: Colors.white),
                ),
                const SizedBox(height: 20),
                const Text('网站客户端', textAlign: TextAlign.center, style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
                const SizedBox(height: 4),
                Text('登录以继续', textAlign: TextAlign.center, style: TextStyle(color: Colors.grey.shade500)),
                const SizedBox(height: 32),
                // 表单卡片
                Container(
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: Theme.of(context).colorScheme.surface,
                    borderRadius: BorderRadius.circular(16),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withValues(alpha: 0.05),
                        blurRadius: 16,
                        offset: const Offset(0, 4),
                      ),
                    ],
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      TextField(
                        controller: _username,
                        decoration: const InputDecoration(labelText: '用户名', prefixIcon: Icon(Icons.person_outline)),
                        textInputAction: TextInputAction.next,
                      ),
                      const SizedBox(height: 16),
                      TextField(
                        controller: _password,
                        obscureText: _obscure,
                        decoration: InputDecoration(
                          labelText: '密码',
                          prefixIcon: const Icon(Icons.lock_outline),
                          suffixIcon: IconButton(
                            icon: Icon(_obscure ? Icons.visibility_off : Icons.visibility),
                            onPressed: () => setState(() => _obscure = !_obscure),
                          ),
                        ),
                        onSubmitted: (_) => _login(),
                      ),
                      if (_error != null) ...[
                        const SizedBox(height: 12),
                        Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: Colors.red)),
                      ],
                      const SizedBox(height: 24),
                      ElevatedButton(
                        onPressed: (canLogin && !loading) ? _login : null,
                        child: loading
                            ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                            : const Text('登录'),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                TextButton(
                  onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const RegisterScreen())),
                  child: const Text('没有账号？去注册'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
