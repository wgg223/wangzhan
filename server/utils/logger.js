const util = require('util');

const isProd = (process.env.NODE_ENV === 'production');

function formatArgs(args) {
  return args.map(a => (typeof a === 'string' ? a : util.inspect(a))).join(' ');
}

module.exports = {
  debug: (...args) => { if (!isProd) console.debug('[debug]', formatArgs(args)); },
  info: (...args) => { console.info('[info]', formatArgs(args)); },
  warn: (...args) => { console.warn('[warn]', formatArgs(args)); },
  error: (...args) => { console.error('[error]', formatArgs(args)); },
  isProd
};
