@echo off
chcp 65001 >nul

echo === CDN配置部署脚本 (Windows) ===
echo.

REM 检查Nginx是否安装
where nginx >nul 2>nul
if %errorlevel% neq 0 (
    echo 错误: Nginx未安装
    echo 请先安装Nginx
    pause
    exit /b 1
)

REM 检查Node.js是否安装
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo 错误: Node.js未安装
    echo 请先安装Node.js
    pause
    exit /b 1
)

echo 1. 检查Nginx配置目录...
if not exist "C:\nginx\conf\sites-available" (
    echo 创建Nginx配置目录...
    mkdir "C:\nginx\conf\sites-available"
    mkdir "C:\nginx\conf\sites-enabled"
)

echo.
echo 2. 复制Nginx配置文件...
copy nginx-cdn.conf.example "C:\nginx\conf\sites-available\dalaowang233.top.conf"
echo 配置文件已复制

echo.
echo 3. 创建符号链接...
if not exist "C:\nginx\conf\sites-enabled\dalaowang233.top.conf" (
    mklink "C:\nginx\conf\sites-enabled\dalaowang233.top.conf" "C:\nginx\conf\sites-available\dalaowang233.top.conf"
    echo 符号链接创建成功
) else (
    echo 符号链接已存在
)

echo.
echo 4. 测试Nginx配置...
nginx -t
if %errorlevel% neq 0 (
    echo 错误: Nginx配置测试失败
    echo 请检查配置文件
    pause
    exit /b 1
)

echo.
echo 5. 重载Nginx配置...
nginx -s reload
if %errorlevel% neq 0 (
    echo 错误: Nginx配置重载失败
    pause
    exit /b 1
)

echo.
echo 6. 检查环境变量文件...
if not exist ".env" (
    echo 创建.env文件...
    copy .env.example .env
    echo .env文件已创建，请编辑填入实际值
) else (
    echo .env文件已存在
)

echo.
echo 7. 检查Node.js应用...
if exist "package.json" (
    echo 检查依赖...
    if not exist "node_modules" (
        echo 安装依赖...
        npm install
    )
    echo 依赖检查完成
) else (
    echo 警告: 未找到package.json
)

echo.
echo 8. 测试CDN配置...
if exist "test-cdn.js" (
    node test-cdn.js
) else (
    echo 警告: 未找到test-cdn.js
)

echo.
echo === 部署完成 ===
echo.
echo 下一步操作:
echo 1. 编辑 .env 文件，填入实际配置
echo 2. 在CDN服务商处配置CNAME记录
echo 3. 配置SSL证书
echo 4. 测试网站访问
echo.
echo 配置文件位置:
echo - Nginx配置: C:\nginx\conf\sites-available\dalaowang233.top.conf
echo - 环境变量: .env
echo - CDN配置: cdn-config.js
echo.
echo 常用命令:
echo - 测试Nginx配置: nginx -t
echo - 重载Nginx: nginx -s reload
echo - 查看Nginx状态: tasklist /fi "imagename eq nginx.exe"
echo - 查看Nginx日志: type C:\nginx\logs\error.log
echo.
echo 如需帮助，请查看CDN配置指南.md
echo.
pause