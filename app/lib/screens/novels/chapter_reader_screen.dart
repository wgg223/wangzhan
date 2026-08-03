import 'package:flutter/material.dart';

import '../../api/novel_api.dart';
import '../../models/novel.dart';
import '../../widgets/common.dart';

/// 章节阅读器（支持字号调整）
class ChapterReaderScreen extends StatefulWidget {
  const ChapterReaderScreen({super.key, required this.novelId, required this.chapterId, required this.chapterTitle});

  final int novelId;
  final int chapterId;
  final String chapterTitle;

  @override
  State<ChapterReaderScreen> createState() => _ChapterReaderScreenState();
}

class _ChapterReaderScreenState extends State<ChapterReaderScreen> {
  late Future<NovelChapter> _future;
  double _fontSize = 17;

  @override
  void initState() {
    super.initState();
    _future = NovelApi.chapter(widget.novelId, widget.chapterId);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.chapterTitle, maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [
          IconButton(
            icon: const Icon(Icons.format_size),
            onPressed: () => setState(() => _fontSize = _fontSize >= 21 ? 15 : _fontSize + 2),
          ),
        ],
      ),
      body: FutureView(
        future: _future,
        reload: () => setState(() => _future = NovelApi.chapter(widget.novelId, widget.chapterId)),
        builder: (context, chapter) {
          final content = chapter.content.isNotEmpty
              ? chapter.content
              : '章节内容为空';
          return SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 40),
            child: Text(
              content,
              style: TextStyle(fontSize: _fontSize, height: 1.9),
            ),
          );
        },
      ),
    );
  }
}
