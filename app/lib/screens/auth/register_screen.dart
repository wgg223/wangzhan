import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../../api/api_client.dart';
import '../../api/auth_api.dart';

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _username = TextEditingController();
  final _nickname = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _confirm = TextEditingController();
  final _captchaInput = TextEditingController();
  bool _obscure = true;
  bool _loading = false;
  String? _error;

  // 图形验证码
  String _captchaId = '';
  String _captchaSvg = '';

  @override
  void initState() {
    super.initState();
    _loadCaptcha();
  }

  @override
  void dispose() {
    _username.dispose();
    _nickname.dispose();
    _email.dispose();
    _password.dispose();
    _confirm.dispose();
    _captchaInput.dispose();
    super.dispose();
  }

  Future<void> _loadCaptcha() async {
    try {
      final (id, svg) = await AuthApi.captcha();
      if (mounted) {
        setState(() {
          _captchaId = id;
          _captchaSvg = svg;
          _captchaInput.clear();
        });
      }
    } catch (_) {
      // 验证码加载失败不阻塞注册页，提交时会被后端拒绝
    }
  }

  Future<void> _register() async {
    final username = _username.text.trim();
    final password = _password.text;
    if (username.length < 2) {
      setState(() => _error = '用户名至少 2 个字符');
      return;
    }
    if (password.length < 6) {
      setState(() => _error = '密码至少 6 位');
      return;
    }
    if (password != _confirm.text) {
      setState(() => _error = '两次输入的密码不一致');
      return;
    }
    if (_captchaInput.text.trim().isEmpty) {
      setState(() => _error = '请输入图形验证码');
      return;
    }
    setState(() => _loading = true);
    try {
      await AuthApi.register(
        username: username,
        password: password,
        nickname: _nickname.text.trim(),
        email: _email.text.trim(),
        captchaId: _captchaId,
        captcha: _captchaInput.text.trim(),
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('注册成功，请登录')));
      Navigator.pop(context);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
      _loadCaptcha(); // 验证码用后即焚，失败后刷新
    } catch (_) {
      setState(() => _error = '网络错误，请检查连接');
      _loadCaptcha();
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('注册账号')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: _username,
                decoration: const InputDecoration(labelText: '用户名 *', prefixIcon: Icon(Icons.person_outline)),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _nickname,
                decoration: const InputDecoration(labelText: '昵称', prefixIcon: Icon(Icons.badge_outlined)),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                decoration: const InputDecoration(labelText: '邮箱（可选）', prefixIcon: Icon(Icons.email_outlined)),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _password,
                obscureText: _obscure,
                decoration: InputDecoration(
                  labelText: '密码 *（至少6位）',
                  prefixIcon: const Icon(Icons.lock_outline),
                  suffixIcon: IconButton(
                    icon: Icon(_obscure ? Icons.visibility_off : Icons.visibility),
                    onPressed: () => setState(() => _obscure = !_obscure),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _confirm,
                obscureText: _obscure,
                decoration: const InputDecoration(labelText: '确认密码 *', prefixIcon: Icon(Icons.lock_outline)),
              ),
              const SizedBox(height: 16),
              // 图形验证码
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Expanded(
                    child: TextField(
                      controller: _captchaInput,
                      decoration: const InputDecoration(
                        labelText: '图形验证码 *',
                        prefixIcon: Icon(Icons.verified_outlined),
                        hintText: '请输入图中计算结果',
                      ),
                      maxLength: 10,
                    ),
                  ),
                  const SizedBox(width: 12),
                  GestureDetector(
                    onTap: _loadCaptcha,
                    child: Container(
                      width: 120,
                      height: 48,
                      decoration: BoxDecoration(
                        border: Border.all(color: Colors.grey.shade300),
                        borderRadius: BorderRadius.circular(10),
                        color: Colors.grey.shade100,
                      ),
                      clipBehavior: Clip.antiAlias,
                      child: _captchaSvg.isNotEmpty
                          ? SvgPicture.string(_captchaSvg, width: 120, height: 48, fit: BoxFit.cover)
                          : Center(
                              child: Icon(Icons.refresh, color: Colors.grey.shade400),
                            ),
                    ),
                  ),
                ],
              ),
              Row(
                children: [
                  Text('点击图片刷新验证码', style: TextStyle(fontSize: 11, color: Colors.grey.shade400)),
                ],
              ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: Colors.red)),
              ],
              const SizedBox(height: 24),
              ElevatedButton(
                onPressed: _loading ? null : _register,
                child: _loading
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('注册'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
