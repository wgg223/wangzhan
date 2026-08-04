/// 数值强制转换工具。
library;

/// 将任意值安全转为 int；非法/缺失时返回 [fallback]（默认 0）。
int toInt(dynamic v, {int fallback = 0}) {
  if (v is int) return v;
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v) ?? fallback;
  return fallback;
}
