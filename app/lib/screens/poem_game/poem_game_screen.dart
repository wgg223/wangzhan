import 'dart:math';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../api/poem_api.dart';
import '../../models/poem.dart';
import '../../state/auth_state.dart';
import '../../widgets/common.dart';

/// 诗词游戏：接龙 / 飞花令 / 猜诗名
class PoemGameScreen extends StatefulWidget {
  const PoemGameScreen({super.key});

  @override
  State<PoemGameScreen> createState() => _PoemGameScreenState();
}

class _PoemGameScreenState extends State<PoemGameScreen> {
  int _tab = 0; // 0 游戏, 1 排行榜

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('诗词游戏'),
        bottom: TabBar(
          tabs: const [Tab(text: '开始游戏'), Tab(text: '排行榜')],
          onTap: (i) => setState(() => _tab = i),
        ),
      ),
      body: _tab == 0 ? const _GamePanel() : const _LeaderboardPanel(),
    );
  }
}

// ==================== 游戏 ====================

class _GamePanel extends StatefulWidget {
  const _GamePanel();

  @override
  State<_GamePanel> createState() => _GamePanelState();
}

class _GamePanelState extends State<_GamePanel> {
  static const _modes = ['接龙', '飞花令', '猜诗名'];
  String _mode = '接龙';
  List<Poem> _pool = [];
  List<_Question> _questions = [];
  int _current = 0;
  int _score = 0;
  int _combo = 0;
  int _maxCombo = 0;
  int _correct = 0;
  int? _selected;
  bool _gameOver = false;
  bool _loading = false;
  String? _error;
  final Random _rng = Random();

  Future<void> _start() async {
    setState(() {
      _loading = true;
      _error = null;
      _gameOver = false;
      _current = 0;
      _score = 0;
      _combo = 0;
      _maxCombo = 0;
      _correct = 0;
      _selected = null;
      _questions = [];
    });
    try {
      final poems = await PoemApi.random(count: 20);
      if (poems.length < 4) throw Exception('题库不足');
      setState(() {
        _pool = poems;
        _questions = _buildQuestions(poems);
        _loading = false;
      });
    } catch (_) {
      setState(() {
        _loading = false;
        _error = '获取题目失败，请检查网络';
      });
    }
  }

  List<_Question> _buildQuestions(List<Poem> poems) {
    final questions = <_Question>[];
    for (var i = 0; i < poems.length && questions.length < 10; i++) {
      final poem = poems[i];
      final others = poems.where((p) => p.id != poem.id).toList();
      if (others.length < 3) continue;
      others.shuffle(_rng);
      final options = [poem, ...others.take(3)]..shuffle(_rng);
      switch (_mode) {
        case '飞花令':
          final keyword = _pickKeyword(poem);
          if (keyword.isEmpty) continue;
          questions.add(_Question(
            prompt: '请找出包含「$keyword」的诗句',
            hint: poem.title,
            poem: poem,
            options: options,
            answerIndex: options.indexOf(poem),
          ));
          break;
        case '猜诗名':
          final title = poem.title;
          final fakeTitles = others.map((o) => o.title).where((t) => t != title).take(3).toList();
          while (fakeTitles.length < 3) {
            fakeTitles.add('佚名诗');
          }
          final opts = [title, ...fakeTitles]..shuffle(_rng);
          questions.add(_Question(
            prompt: '这首诗（节选）的诗名是？',
            hint: poem.paragraphs.take(2).join('，'),
            poem: poem,
            options: opts.map((o) => _FakePoem(o)).toList(),
            answerIndex: opts.indexOf(title),
          ));
          break;
        default: // 接龙
          final lastChar = _lastChar(poem);
          if (lastChar.isEmpty) continue;
          final matches = poems.where((p) => p.id != poem.id && _firstChar(p) == lastChar).toList();
          if (matches.isEmpty) continue;
          final fake = others.where((p) => p.id != poem.id && _firstChar(p) != lastChar).take(3).toList();
          if (fake.length < 3) continue;
          final options = [matches.first, ...fake]..shuffle(_rng);
          questions.add(_Question(
            prompt: '「$lastChar」字开头，下一句是？',
            hint: '${poem.title} · ${poem.author}',
            poem: matches.first,
            options: options,
            answerIndex: options.indexOf(matches.first),
          ));
      }
    }
    return questions;
  }

  String _lastChar(Poem p) {
    for (final para in p.paragraphs.reversed) {
      final s = para.trim();
      if (s.isEmpty) continue;
      return s[s.length - 1];
    }
    return '';
  }

  String _firstChar(Poem p) {
    for (final para in p.paragraphs) {
      final s = para.trim();
      if (s.isEmpty) continue;
      return s[0];
    }
    return '';
  }

  String _pickKeyword(Poem p) {
    final chars = p.fullText.replaceAll(RegExp(r'[^\u4e00-\u9fa5]'), '');
    if (chars.isEmpty) return '';
    final frequent = '花月风云山水春雪江天'.split('');
    for (final c in frequent) {
      if (chars.contains(c)) return c;
    }
    return chars[chars.length ~/ 2];
  }

  void _answer(int index) {
    if (_selected != null) return;
    setState(() {
      _selected = index;
      final q = _questions[_current];
      if (index == q.answerIndex) {
        _correct++;
        _combo++;
        _maxCombo = max(_maxCombo, _combo);
        _score += 10 + _combo * 2;
      } else {
        _combo = 0;
      }
    });
  }

  Future<void> _next() async {
    if (_current + 1 >= _questions.length) {
      setState(() => _gameOver = true);
      await _submitScore();
      return;
    }
    setState(() {
      _current++;
      _selected = null;
    });
  }

  Future<void> _submitScore() async {
    final auth = context.read<AuthState>();
    if (!auth.isLoggedIn) return;
    try {
      await PoemApi.submitScore(
        gameMode: _mode,
        difficulty: 'easy',
        score: _score,
        comboMax: _maxCombo,
        correctCount: _correct,
        totalCount: _questions.length,
      );
    } catch (_) {
      // 提交失败不阻塞游戏结束
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const LoadingView();
    if (_error != null) {
      return ErrorView(message: _error!, onRetry: _start);
    }
    if (_questions.isEmpty) {
      return Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.menu_book, size: 64, color: Color(0xFF7C3AED)),
          const SizedBox(height: 16),
          const Text('选择玩法开始挑战', style: TextStyle(fontSize: 16)),
          const SizedBox(height: 16),
          SegmentedButton<String>(
            segments: _modes.map((m) => ButtonSegment(value: m, label: Text(m))).toList(),
            selected: {_mode},
            onSelectionChanged: (s) => setState(() => _mode = s.first),
          ),
          const SizedBox(height: 24),
          ElevatedButton(onPressed: _start, child: const Text('开始游戏')),
        ],
      );
    }
    if (_gameOver) {
      return _GameOverView(
        score: _score,
        correct: _correct,
        total: _questions.length,
        maxCombo: _maxCombo,
        onRestart: _start,
      );
    }
    final q = _questions[_current];
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          LinearProgressIndicator(value: (_current + 1) / _questions.length),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('第 ${_current + 1}/${_questions.length} 题', style: TextStyle(color: Colors.grey.shade600)),
              Text('得分 $_score · 连击 $_combo', style: const TextStyle(color: Color(0xFF2563EB), fontWeight: FontWeight.w600)),
            ],
          ),
          const SizedBox(height: 24),
          Text(q.prompt, textAlign: TextAlign.center, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Text(q.hint, textAlign: TextAlign.center, style: TextStyle(fontSize: 13, color: Colors.grey.shade500)),
          const SizedBox(height: 24),
          ...q.options.asMap().entries.map((e) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _OptionTile(
                  label: e.value.title,
                  author: e.value.author,
                  selected: _selected == e.key,
                  correct: _selected != null && e.key == q.answerIndex,
                  wrong: _selected != null && e.key == _selected && e.key != q.answerIndex,
                  onTap: () => _answer(e.key),
                ),
              )),
          const Spacer(),
          if (_selected != null)
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(onPressed: _next, child: Text(_current + 1 >= _questions.length ? '查看成绩' : '下一题')),
            ),
        ],
      ),
    );
  }
}

class _Question {
  _Question({required this.prompt, required this.hint, required this.poem, required this.options, required this.answerIndex});
  final String prompt;
  final String hint;
  final Poem poem;
  final List<Poem> options;
  final int answerIndex;
}

class _FakePoem extends Poem {
  _FakePoem(String title) : super(title: title, author: '');
}

class _OptionTile extends StatelessWidget {
  const _OptionTile({required this.label, required this.author, this.selected = false, this.correct = false, this.wrong = false, this.onTap});

  final String label;
  final String author;
  final bool selected;
  final bool correct;
  final bool wrong;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    Color? borderColor;
    if (correct) borderColor = Colors.green;
    if (wrong) borderColor = Colors.red;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          border: Border.all(color: borderColor ?? (selected ? const Color(0xFF2563EB) : Colors.grey.shade300), width: borderColor != null ? 2 : 1),
          borderRadius: BorderRadius.circular(10),
          color: correct ? Colors.green.withOpacity(0.08) : (wrong ? Colors.red.withOpacity(0.08) : null),
        ),
        child: Row(
          children: [
            Icon(
              correct ? Icons.check_circle : (wrong ? Icons.cancel : Icons.circle_outlined),
              size: 20,
              color: correct ? Colors.green : (wrong ? Colors.red : Colors.grey.shade400),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(label, style: const TextStyle(fontSize: 15), maxLines: 2, overflow: TextOverflow.ellipsis),
            ),
          ],
        ),
      ),
    );
  }
}

class _GameOverView extends StatelessWidget {
  const _GameOverView({required this.score, required this.correct, required this.total, required this.maxCombo, required this.onRestart});

  final int score;
  final int correct;
  final int total;
  final int maxCombo;
  final VoidCallback onRestart;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.emoji_events, size: 72, color: Color(0xFFF59E0B)),
          const SizedBox(height: 16),
          Text('$score', style: const TextStyle(fontSize: 44, fontWeight: FontWeight.bold, color: Color(0xFF2563EB))),
          const Text('最终得分', style: TextStyle(color: Colors.grey)),
          const SizedBox(height: 24),
          Text('答对 $correct/$total 题 · 最高连击 $maxCombo'),
          const SizedBox(height: 32),
          ElevatedButton(onPressed: onRestart, child: const Text('再来一局')),
        ],
      ),
    );
  }
}

// ==================== 排行榜 ====================

class _LeaderboardPanel extends StatefulWidget {
  const _LeaderboardPanel();

  @override
  State<_LeaderboardPanel> createState() => _LeaderboardPanelState();
}

class _LeaderboardPanelState extends State<_LeaderboardPanel> {
  late Future<List<LeaderboardEntry>> _future;

  @override
  void initState() {
    super.initState();
    _future = PoemApi.leaderboard();
  }

  @override
  Widget build(BuildContext context) {
    return FutureView(
      future: _future,
      reload: () => setState(() => _future = PoemApi.leaderboard()),
      builder: (context, list) {
        if (list.isEmpty) return const EmptyView(message: '暂无排行榜数据');
        return ListView.separated(
          itemCount: list.length,
          separatorBuilder: (c, i) => const Divider(height: 1),
          itemBuilder: (context, i) {
            final e = list[i];
            return ListTile(
              leading: CircleAvatar(
                child: Text('${i + 1}'),
              ),
              title: Text(e.username),
              subtitle: Text('${e.gameMode} · ${e.difficulty}'),
              trailing: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text('${e.score} 分', style: const TextStyle(fontWeight: FontWeight.w600)),
                  Text('连击 ${e.comboMax}', style: TextStyle(fontSize: 11, color: Colors.grey.shade500)),
                ],
              ),
            );
          },
        );
      },
    );
  }
}
