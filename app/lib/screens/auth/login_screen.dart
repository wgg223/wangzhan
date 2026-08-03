import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../api/api_client.dart';
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

  Future<void> _login() async {
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
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Icon(Icons.public, size: 72, color: Color(0xFF2563EB)),
                const SizedBox(height: 16),
                const Text('网站客户端', textAlign: TextAlign.center, style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
                const SizedBox(height: 4),
                Text('登录以继续', textAlign: TextAlign.center, style: TextStyle(color: Colors.grey.shade500)),
                const SizedBox(height: 32),
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
                  onPressed: loading ? null : _login,
                  child: loading
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Text('登录'),
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
