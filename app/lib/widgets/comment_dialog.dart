import 'package:flutter/material.dart';

/// 弹出评论输入框，返回输入的文本（取消或为空返回 null）
Future<String?> showCommentDialog(
  BuildContext context, {
  String title = '发表评论',
  String hint = '说点什么...',
  int maxLines = 3,
  String confirmText = '发表',
}) {
  final controller = TextEditingController();
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: TextField(
        controller: controller,
        maxLines: maxLines,
        autofocus: true,
        decoration: InputDecoration(hintText: hint),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
        TextButton(
          onPressed: () => Navigator.pop(ctx, controller.text),
          child: Text(confirmText),
        ),
      ],
    ),
  );
}
