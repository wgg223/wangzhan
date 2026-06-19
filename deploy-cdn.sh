#!/bin/bash

# CDN配置部署脚本
# 使用方法: ./deploy-cdn.sh

set -e

echo "=== CDN配置部署脚本 ==="
echo ""

# 检查是否为root用户
if [ "$EUID" -ne 0 ]; then
  echo "请使用sudo运行此脚本"
  exit 1
fi

# 检查Nginx是否安装
if ! command -v nginx &> /dev/null; then
    echo "错误: Nginx未安装"
    echo "请先安装Nginx: sudo apt install nginx"
    exit 1
fi

# 检查Node.js是否安装
if ! command -v node &> /dev/null; then
    echo "错误: Node.js未安装"
    echo "请先安装Node.js"
    exit 1
fi

echo "1. 备份现有Nginx配置..."
if [ -f /etc/nginx/sites-available/dalaowang233.top ]; then
    cp /etc/nginx/sites-available/dalaowang233.top /etc/nginx/sites-available/dalaowang233.top.backup.$(date +%Y%m%d%H%M%S)
    echo "   备份完成"
else
    echo "   未找到现有配置，跳过备份"
fi

echo ""
echo "2. 复制Nginx配置文件..."
cp nginx-cdn.conf.example /etc/nginx/sites-available/dalaowang233.top
echo "   配置文件已复制"

echo ""
echo "3. 创建符号链接..."
if [ ! -L /etc/nginx/sites-enabled/dalaowang233.top ]; then
    ln -s /etc/nginx/sites-available/dalaowang233.top /etc/nginx/sites-enabled/
    echo "   符号链接创建成功"
else
    echo "   符号链接已存在"
fi

echo ""
echo "4. 测试Nginx配置..."
if nginx -t; then
    echo "   Nginx配置测试通过"
else
    echo "   错误: Nginx配置测试失败"
    echo "   请检查配置文件"
    exit 1
fi

echo ""
echo "5. 重载Nginx配置..."
if systemctl reload nginx; then
    echo "   Nginx配置重载成功"
else
    echo "   错误: Nginx配置重载失败"
    exit 1
fi

echo ""
echo "6. 检查环境变量文件..."
if [ ! -f .env ]; then
    echo "   创建.env文件..."
    cp .env.example .env
    echo "   .env文件已创建，请编辑填入实际值"
else
    echo "   .env文件已存在"
fi

echo ""
echo "7. 检查Node.js应用..."
if [ -f package.json ]; then
    echo "   检查依赖..."
    if [ ! -d node_modules ]; then
        echo "   安装依赖..."
        npm install
    fi
    echo "   依赖检查完成"
else
    echo "   警告: 未找到package.json"
fi

echo ""
echo "8. 测试CDN配置..."
if [ -f test-cdn.js ]; then
    node test-cdn.js
else
    echo "   警告: 未找到test-cdn.js"
fi

echo ""
echo "=== 部署完成 ==="
echo ""
echo "下一步操作:"
echo "1. 编辑 .env 文件，填入实际配置"
echo "2. 在CDN服务商处配置CNAME记录"
echo "3. 配置SSL证书"
echo "4. 测试网站访问"
echo ""
echo "配置文件位置:"
echo "- Nginx配置: /etc/nginx/sites-available/dalaowang233.top"
echo "- 环境变量: .env"
echo "- CDN配置: cdn-config.js"
echo ""
echo "常用命令:"
echo "- 测试Nginx配置: sudo nginx -t"
echo "- 重载Nginx: sudo systemctl reload nginx"
echo "- 查看Nginx状态: sudo systemctl status nginx"
echo "- 查看Nginx日志: sudo tail -f /var/log/nginx/error.log"
echo ""
echo "如需帮助，请查看CDN配置指南.md"