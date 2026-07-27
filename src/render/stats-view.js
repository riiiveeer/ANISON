/**
 * 统计视图层。
 */

export function renderStats(container, stats) {
  const { total = 0, japanese = 0, english = 0 } = stats || {};

  container.innerHTML = `
    <div class="stat-item">
      <span class="stat-value">${total}</span>
      <span class="stat-label">句歌词</span>
    </div>
    <div class="stat-item">
      <span class="stat-value">${japanese}</span>
      <span class="stat-label">日语句</span>
    </div>
    <div class="stat-item">
      <span class="stat-value">${english}</span>
      <span class="stat-label">英文句</span>
    </div>
  `;
}
