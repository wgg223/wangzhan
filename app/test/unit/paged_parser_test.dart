import 'package:flutter_test/flutter_test.dart';
import 'package:mi_app/utils/paged.dart';

class _Item {
  _Item(this.id);
  final int id;

  factory _Item.fromJson(Map<String, dynamic> json) => _Item(json['id'] as int);
}

void main() {
  group('parsePage<T>', () {
    test('标准分页返回 (list, total)', () {
      final (items, total) = parsePage<_Item>(
        {'list': [{'id': 1}, {'id': 2}], 'total': 2},
        'list',
        _Item.fromJson,
      );
      expect(items, hasLength(2));
      expect(items.first.id, 1);
      expect(total, 2);
    });

    test('缺 list 字段时返回空列表', () {
      final (items, total) = parsePage<_Item>(
        {'total': 3},
        'list',
        _Item.fromJson,
      );
      expect(items, isEmpty);
      expect(total, 3);
    });

    test('list 非 List 时返回空列表', () {
      final (items, total) = parsePage<_Item>(
        {'list': 'not-a-list', 'total': 3},
        'list',
        _Item.fromJson,
      );
      expect(items, isEmpty);
      expect(total, 3);
    });

    test('total 缺省为 0', () {
      final (items, total) = parsePage<_Item>(
        {'list': [{'id': 1}]},
        'list',
        _Item.fromJson,
      );
      expect(items, hasLength(1));
      expect(total, 0);
    });

    test('total 为字符串数字时转为 int', () {
      final (items, total) = parsePage<_Item>(
        {'list': [], 'total': '12'},
        'list',
        _Item.fromJson,
      );
      expect(items, isEmpty);
      expect(total, 12);
    });

    test('列表元素非 Map 时跳过', () {
      final (items, total) = parsePage<_Item>(
        {'list': [{'id': 1}, 'bad', null], 'total': 2},
        'list',
        _Item.fromJson,
      );
      expect(items, hasLength(1));
      expect(total, 2);
    });

    test('自定义 key 生效', () {
      final (items, total) = parsePage<_Item>(
        {'rows': [{'id': 9}], 'total': 1},
        'rows',
        _Item.fromJson,
      );
      expect(items, hasLength(1));
      expect(items.first.id, 9);
      expect(total, 1);
    });
  });

  group('toInt', () {
    test('int 原样返回', () {
      expect(toInt(42), 42);
    });

    test('数字字符串转 int', () {
      expect(toInt('42'), 42);
    });

    test('null 返回 fallback', () {
      expect(toInt(null), 0);
      expect(toInt(null, fallback: 7), 7);
    });

    test('非法值返回 fallback', () {
      expect(toInt('abc'), 0);
      expect(toInt({'a': 1}, fallback: -1), -1);
    });
  });
}
