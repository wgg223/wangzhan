import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../api/image_share_api.dart';
import '../../models/image_item.dart';

/// 图片上传页
class ImageUploadScreen extends StatefulWidget {
  const ImageUploadScreen({super.key});

  @override
  State<ImageUploadScreen> createState() => _ImageUploadScreenState();
}

class _ImageUploadScreenState extends State<ImageUploadScreen> {
  final _title = TextEditingController();
  final _description = TextEditingController();
  final List<String> _picked = [];
  List<ImageCategory> _categories = [];
  int? _categoryId;
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadCategories();
  }

  Future<void> _loadCategories() async {
    try {
      final cats = await ImageShareApi.categories();
      if (mounted) setState(() => _categories = cats);
    } catch (_) {}
  }

  Future<void> _pickImages() async {
    final picker = ImagePicker();
    final files = await picker.pickMultiImage();
    if (files.isEmpty) return;
    setState(() => _picked.addAll(files.map((f) => f.path)));
  }

  Future<void> _submit() async {
    if (_picked.isEmpty) {
      setState(() => _error = '请选择图片');
      return;
    }
    if (_title.text.trim().isEmpty) {
      setState(() => _error = '请输入标题');
      return;
    }
    if (_categoryId == null) {
      setState(() => _error = '请选择分类');
      return;
    }
    setState(() => _loading = true);
    try {
      await ImageShareApi.upload(
        filePaths: _picked,
        title: _title.text.trim(),
        description: _description.text.trim(),
        categoryId: _categoryId!,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('上传成功，等待审核')));
      Navigator.pop(context, true);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = '上传失败，请重试');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('上传图片')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // 已选图片预览
            if (_picked.isNotEmpty)
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: _picked
                    .map((p) => Stack(
                          children: [
                            Image.file(File(p), width: 90, height: 90, fit: BoxFit.cover),
                            Positioned(
                              top: 0,
                              right: 0,
                              child: InkWell(
                                onTap: () => setState(() => _picked.remove(p)),
                                child: Container(
                                  color: Colors.black54,
                                  child: const Icon(Icons.close, size: 16, color: Colors.white),
                                ),
                              ),
                            ),
                          ],
                        ))
                    .toList(),
              ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: _pickImages,
              icon: const Icon(Icons.add_photo_alternate_outlined),
              label: const Text('选择图片（可多选）'),
            ),
            const SizedBox(height: 16),
            TextField(controller: _title, decoration: const InputDecoration(labelText: '标题 *')),
            const SizedBox(height: 16),
            TextField(controller: _description, maxLines: 3, decoration: const InputDecoration(labelText: '描述')),
            const SizedBox(height: 16),
            // 分类选择
            Wrap(
              spacing: 8,
              children: _categories
                  .map((c) => ChoiceChip(
                        label: Text(c.name),
                        selected: _categoryId == c.id,
                        onSelected: (_) => setState(() => _categoryId = c.id),
                      ))
                  .toList(),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: Colors.red)),
            ],
            const SizedBox(height: 24),
            ElevatedButton(
              onPressed: _loading ? null : _submit,
              child: _loading
                  ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('上传'),
            ),
          ],
        ),
      ),
    );
  }
}
