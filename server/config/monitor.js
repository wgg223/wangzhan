/**
 * 系统资源监控模块
 * 监控内存、CPU使用情况，并在内存过高时触发GC
 */
const os = require('os');

class SystemMonitor {
  constructor(options = {}) {
    this.warningMemoryPercent = options.warningMemoryPercent || 75; // 内存使用超75%预警
    this.criticalMemoryPercent = options.criticalMemoryPercent || 90; // 超90%临界
    this.checkInterval = options.checkInterval || 30000; // 30秒检查一次
    this.logger = options.logger || console;

    this.startTime = Date.now();
    this.requestCount = 0;
    this.errorCount = 0;
    this.lastCpuUsage = process.cpuUsage();
    this.lastCheckTime = Date.now();

    // 启动定时检查
    this._timer = setInterval(() => this.check(), this.checkInterval);
    this._timer.unref(); // 不阻止进程退出
  }

  /**
   * 获取系统信息
   */
  getSystemInfo() {
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const systemMemPercent = ((usedMem / totalMem) * 100).toFixed(1);

    // 计算CPU使用率
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });

    return {
      // 进程内存
      processMemory: {
        rss: this._formatBytes(memUsage.rss),
        heapTotal: this._formatBytes(memUsage.heapTotal),
        heapUsed: this._formatBytes(memUsage.heapUsed),
        external: this._formatBytes(memUsage.external || 0),
        heapUsedPercent: ((memUsage.heapUsed / memUsage.heapTotal) * 100).toFixed(1) + '%'
      },
      // 系统内存
      systemMemory: {
        total: this._formatBytes(totalMem),
        free: this._formatBytes(freeMem),
        used: this._formatBytes(usedMem),
        percent: systemMemPercent + '%'
      },
      // CPU
      cpu: {
        cores: cpus.length,
        model: cpus[0]?.model || 'unknown',
        loadAvg: os.loadavg()
      },
      // 运行时
      uptime: this._formatUptime(process.uptime()),
      startedAt: new Date(this.startTime).toISOString(),
      // 请求统计
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      // Node.js版本
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch
    };
  }

  /**
   * 执行健康检查
   */
  check() {
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const systemMemPercent = ((totalMem - freeMem) / totalMem) * 100;

    // 检查进程内存
    const heapPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;

    // 检查系统内存
    if (systemMemPercent > this.criticalMemoryPercent) {
      this.logger.warn(`[监控] 系统内存使用率临界: ${systemMemPercent.toFixed(1)}%`);
      this._tryGC();
    } else if (systemMemPercent > this.warningMemoryPercent) {
      this.logger.warn(`[监控] 系统内存使用率预警: ${systemMemPercent.toFixed(1)}%`);
    }

    // 检查堆内存
    if (heapPercent > 90) {
      this.logger.warn(`[监控] V8堆内存使用率过高: ${heapPercent.toFixed(1)}%`);
      this._tryGC();
    }
  }

  /**
   * 尝试触发垃圾回收
   */
  _tryGC() {
    try {
      if (global.gc) {
        global.gc();
        this.logger.log('[监控] 手动触发垃圾回收完成');
      } else {
        // 未暴露GC，尝试通过内存分配触发
        this.logger.log('[监控] 提示: 使用 --expose-gc 参数可启用手动GC');
      }
    } catch (err) {
      this.logger.error('[监控] 垃圾回收失败:', err.message);
    }
  }

  /**
   * 记录请求
   */
  recordRequest() {
    this.requestCount++;
  }

  /**
   * 记录错误
   */
  recordError() {
    this.errorCount++;
  }

  /**
   * 停止监控
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * 格式化字节
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * 格式化运行时间
   */
  _formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分`);
    parts.push(`${secs}秒`);

    return parts.join('');
  }
}

// 创建全局监控实例
const monitor = new SystemMonitor();

module.exports = { SystemMonitor, monitor };
