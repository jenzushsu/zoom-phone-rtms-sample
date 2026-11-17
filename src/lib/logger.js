const levels = { debug: 10, info: 20, warn: 30, error: 40 };
function createLogger(level = 'info') {
  const threshold = levels[level] ?? levels.info;
  const log = (severity, event, details = {}) => {
    if (levels[severity] < threshold) return;
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level: severity, event, ...details });
    (severity === 'error' ? console.error : console.log)(line);
  };
  return Object.fromEntries(Object.keys(levels).map(key => [key, (event, details) => log(key, event, details)]));
}
module.exports = { createLogger };
