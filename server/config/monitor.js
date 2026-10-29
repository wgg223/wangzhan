/**
 * 系统资源监控模块
 * 监控内存、CPU使用情况，并在内存过高时触发GC
 *
 * 优化：
 *   - CPU 型号等静态信息缓存到实例属性，避免每次 getSystemInfo 都遍历 os.cpus()；
 *   - requestCount / errorCount 采用滑动窗口（每分钟重置），防止长时间运行溢出；
 *   - CPU 使用率改为差值计算（两次采样间隔的 cpu times 差值），结果更准确。
 */
const os = require('os');
const { formatBytes, formatUptime } = require('../utils/format');

class SystemMonitor {
  constructor(options = {}) {
    this.warningMemoryPercent = options.warningMemoryPercent || 75; // 内存使用超75%预警
    this.criticalMemoryPercent = options.criticalMemoryPercent || 90; // 超90%临界
    this.checkInterval = options.checkInterval || 30000; // 30秒检查一次
    this.logger = options.logger || console;

    this.startTime = Date.now();
    this.requestCount = 0;
    this.errorCount = 0;

    // 滑动窗口计数器：每分钟重置一次，防止长时间运行溢出
    this._countResetTimer = setInterval(() => {
      this.requestCount = 0;
      this.errorCount = 0;
    }, 60 * 1000);
    if (this._countResetTimer.unref) {
      this._countResetTimer.unref();
    }

    // 缓存 CPU 静态信息（型号、核心数），避免每次遍历 os.cpus()
    const cpus = os.cpus();
    this._cpuModel = cpus[0]?.model || 'unknown';
    this._cpuCores = cpus.length;

    // CPU 使用率差值计算：保存上次采样的累计 idle/tick
    this._lastCpuTimes = this._getCpuTimes();
    this._lastCpuPercent = 0;

    this.lastCheckTime = Date.now();

    // 启动定时检查
    this._timer = setInterval(() => this.check(), this.checkInterval);
    this._timer.unref(); // 不阻止进程退出
  }

  /**
   * 读取当前 CPU 累计时间（所有核心合计）
   */
  _getCpuTimes() {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    for (let i = 0; i < cpus.length; i++) {
      const cpu = cpus[i];
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    }
    return { idle: totalIdle, total: totalTick };
  }

  /**
   * 计算两次采样之间的 CPU 使用率（百分比）
   */
  _computeCpuPercent() {
    const current = this._getCpuTimes();
    const idleDelta = current.idle - this._lastCpuTimes.idle;
    const totalDelta = current.total - this._lastCpuTimes.total;
    this._lastCpuTimes = current;

    if (totalDelta === 0) return this._lastCpuPercent;
    this._lastCpuPercent = ((1 - idleDelta / totalDelta) * 100);
    return this._lastCpuPercent;
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

    // 使用差值法计算 CPU 使用率（更准确）
    const cpuPercent = this._computeCpuPercent();

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
      // CPU（使用缓存的静态信息 + 差值计算的使用率）
      cpu: {
        cores: this._cpuCores,
        model: this._cpuModel,
        usage: cpuPercent.toFixed(1) + '%',
        loadAvg: os.loadavg()
      },
      // 运行时
      uptime: this._formatUptime(process.uptime()),
      startedAt: new Date(this.startTime).toISOString(),
      // 请求统计（滑动窗口，每分钟重置）
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
    try {
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
        this.logger.warn(
          `[监控] V8堆内存使用率过高: ${heapPercent.toFixed(1)}% ` +
          `(heapUsed=${this._formatBytes(memUsage.heapUsed)}, heapTotal=${this._formatBytes(memUsage.heapTotal)}, ` +
          `rss=${this._formatBytes(memUsage.rss)}, external=${this._formatBytes(memUsage.external || 0)})`
        );
        this._tryGC();
      } else if (heapPercent > 75) {
        this.logger.warn(
          `[监控] V8堆内存使用率预警: ${heapPercent.toFixed(1)}% ` +
          `(heapUsed=${this._formatBytes(memUsage.heapUsed)}, rss=${this._formatBytes(memUsage.rss)})`
        );
      }
    } catch (err) {
      // 健康检查失败不应影响主流程
      this.logger.error('[监控] 健康检查异常:', err.message);
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
        // 未暴露GC，提示启动参数
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
    if (this._countResetTimer) {
      clearInterval(this._countResetTimer);
      this._countResetTimer = null;
    }
  }

  /**
   * 格式化字节
   */
  _formatBytes(bytes) {
    return formatBytes(bytes);
  }

  /**
   * 格式化运行时间
   */
  _formatUptime(seconds) {
    return formatUptime(seconds);
  }
}

// 创建全局监控实例
const monitor = new SystemMonitor();

module.exports = { SystemMonitor, monitor };
