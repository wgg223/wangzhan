/// 时间格式化工具
class TimeFormat {
  TimeFormat._();

  /// 将 ISO 时间字符串格式化为 相对/简短 时间
  static String from(String? iso) {
    if (iso == null || iso.isEmpty) return '';
    final dt = DateTime.tryParse(iso);
    if (dt == null) return iso;
    final now = DateTime.now();
    final diff = now.difference(dt);
    if (diff.inSeconds < 60) return '刚刚';
    if (diff.inMinutes < 60) return '${diff.inMinutes}分钟前';
    if (diff.inHours < 24) return '${diff.inHours}小时前';
    if (diff.inDays < 7) return '${diff.inDays}天前';
    return '${dt.year}-${_p(dt.month)}-${_p(dt.day)}';
  }

  static String _p(int v) => v < 10 ? '0$v' : '$v';
}
