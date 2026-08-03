import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../state/theme_state.dart';

/// 主题设置：外观模式 / 字体 / 背景
class ThemeSettingsScreen extends StatefulWidget {
  const ThemeSettingsScreen({super.key});

  @override
  State<ThemeSettingsScreen> createState() => _ThemeSettingsScreenState();
}

class _ThemeSettingsScreenState extends State<ThemeSettingsScreen> {
  final _bgUrlController = TextEditingController();

  @override
  void dispose() {
    _bgUrlController.dispose();
    super.dispose();
  }

  Widget _sectionTitle(String title) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 20, 4, 8),
      child: Text(title, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Colors.grey.shade500)),
    );
  }

  Widget _choiceChips<T>(List<(T, String, IconData)> items, T current, ValueChanged<T> onChanged) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final (value, label, icon) in items)
          ChoiceChip(
            avatar: Icon(icon, size: 16),
            label: Text(label),
            selected: value == current,
            onSelected: (_) => onChanged(value),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final ts = context.watch<ThemeState>();
    if (_bgUrlController.text != ts.customBgUrl) {
      _bgUrlController.text = ts.customBgUrl;
    }
    return Scaffold(
      appBar: AppBar(title: const Text('主题设置')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _sectionTitle('外观模式'),
          _choiceChips<AppThemeMode>(
            [
              (AppThemeMode.system, '跟随系统', Icons.brightness_auto_outlined),
              (AppThemeMode.light, '亮色', Icons.light_mode_outlined),
              (AppThemeMode.dark, '暗色', Icons.dark_mode_outlined),
            ],
            ts.mode,
            ts.setMode,
          ),
          _sectionTitle('字体'),
          _choiceChips<AppFont>(
            [
              (AppFont.system, '系统默认', Icons.text_fields),
              (AppFont.serif, '衬线', Icons.format_quote),
              (AppFont.sans, '无衬线', Icons.title),
              (AppFont.mono, '等宽', Icons.code),
            ],
            ts.font,
            ts.setFont,
          ),
          _sectionTitle('背景'),
          _choiceChips<AppBackground>(
            [
              (AppBackground.none, '默认', Icons.clear),
              (AppBackground.soft, '柔和渐变', Icons.gradient),
              (AppBackground.dream, '淡紫梦境', Icons.auto_awesome_outlined),
              (AppBackground.night, '深蓝夜空', Icons.nightlight_outlined),
              (AppBackground.custom, '自定义图片', Icons.image_outlined),
            ],
            ts.background,
            ts.setBackground,
          ),
          if (ts.background == AppBackground.custom) ...[
            const SizedBox(height: 12),
            TextField(
              controller: _bgUrlController,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(
                labelText: '背景图片 URL',
                hintText: 'https://example.com/bg.jpg',
                prefixIcon: Icon(Icons.link),
              ),
              onSubmitted: ts.setCustomBgUrl,
            ),
            const SizedBox(height: 8),
            ElevatedButton.icon(
              onPressed: () => ts.setCustomBgUrl(_bgUrlController.text),
              icon: const Icon(Icons.check),
              label: const Text('应用背景图片'),
              style: ElevatedButton.styleFrom(minimumSize: const Size.fromHeight(44)),
            ),
          ],
          const SizedBox(height: 24),
          Text(
            '主题设置仅保存在本机，重新安装后需重新设置。',
            style: TextStyle(fontSize: 12, color: Colors.grey.shade400),
          ),
        ],
      ),
    );
  }
}
