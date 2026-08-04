import 'package:flutter_test/flutter_test.dart';
import 'package:mi_app/models/user.dart';

void main() {
  group('User 角色判断', () {
    test('isAdmin 覆盖 admin 与 super_admin', () {
      expect(User(id: 1, role: 'admin').isAdmin, isTrue);
      expect(User(id: 1, role: 'super_admin').isAdmin, isTrue);
      expect(User(id: 1, role: 'user').isAdmin, isFalse);
      expect(User(id: 1, role: 'visitor').isAdmin, isFalse);
    });

    test('isSuperAdmin 仅 super_admin 为真', () {
      expect(User(id: 1, role: 'super_admin').isSuperAdmin, isTrue);
      expect(User(id: 1, role: 'admin').isSuperAdmin, isFalse);
      expect(User(id: 1, role: 'user').isSuperAdmin, isFalse);
    });

    test('默认角色为普通用户', () {
      final u = User(id: 1);
      expect(u.role, 'user');
      expect(u.isAdmin, isFalse);
      expect(u.isSuperAdmin, isFalse);
    });

    test('fromJson 正确解析 role', () {
      expect(User.fromJson({'id': 1, 'role': 'admin'}).isAdmin, isTrue);
      expect(
        User.fromJson({'id': '2', 'role': 'super_admin'}).isSuperAdmin,
        isTrue,
      );
      expect(User.fromJson({'id': 3}).isAdmin, isFalse);
    });
  });
}
