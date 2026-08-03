import 'package:flutter/material.dart';

import '../../api/novel_api.dart';
import '../../models/novel.dart';
import '../../widgets/common.dart';
import 'chapter_reader_screen.dart';

/// 小说详情页（含章节列表）
class NovelDetailScreen extends StatefulWidget {
  const NovelDetailScreen({super.key, required this.novelId});

  final int novelId;

  @override
  State<NovelDetailScreen> createState() => _NovelDetailScreenState();
}

class _NovelDetailScreenState extends State<NovelDetailScreen> {
  late Future<(Novel, List<NovelChapter>)> _future;

  @override
  void initState() {
    super.initState();
    _future = NovelApi.detail(widget.novelId);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('小说详情')),
      body: FutureView(
        future: _future,
        reload: () => setState(() => _future = NovelApi.detail(widget.novelId)),
        builder: (context, data) {
          final (novel, chapters) = data;
          return ListView(
            children: [
              Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(novel.title, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
                    const SizedBox(height: 8),
                    Text('作者：${novel.author}', style: TextStyle(fontSize: 14, color: Colors.grey.shade600)),
                    const SizedBox(height: 12),
                    Text(novel.description, style: TextStyle(fontSize: 14, height: 1.6, color: Colors.grey.shade700)),
                  ],
                ),
              ),
              const Divider(height: 1),
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text('目录（${chapters.length} 章）', style: const TextStyle(fontWeight: FontWeight.w600)),
              ),
              if (chapters.isEmpty)
                const Padding(padding: EdgeInsets.only(top: 40), child: EmptyView(message: '暂无章节'))
              else
                ...chapters.map((c) => ListTile(
                      dense: true,
                      leading: Text('${c.chapterNumber}', style: TextStyle(color: Colors.grey.shade500, fontSize: 13)),
                      title: Text(c.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                      trailing: const Icon(Icons.chevron_right, size: 18),
                      onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ChapterReaderScreen(novelId: novel.id, chapterId: c.id, chapterTitle: c.title))),
                    )),
            ],
          );
        },
      ),
    );
  }
}
