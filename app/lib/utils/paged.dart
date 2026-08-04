/// 通用分页解析工具。
library;

import 'coercion.dart';

export 'coercion.dart' show toInt;

/// 从分页响应中解析列表与总数，返回 (list, total)。
///
/// - [data][key] 缺失或非 List 时列表为空；
/// - `total` 缺失时按 0 处理；
/// - 列表内非 Map 元素被跳过。
(List<T>, int) parsePage<T>(
  Map<dynamic, dynamic> data,
  String key,
  T Function(Map<String, dynamic>) fromJson,
) {
  final raw = data[key];
  final list = <T>[];
  if (raw is List) {
    for (final item in raw) {
      if (item is Map) {
        list.add(fromJson(item.map((k, v) => MapEntry('$k', v))));
      }
    }
  }
  return (list, toInt(data['total']));
}
