/** Synthetic payloads use a simulation clock, never wall-clock observation claims. */
export function exerciseFrame(payload, capturedAt = new Date().toISOString()) {
  const frame = structuredClone(payload);
  const base = frame.spread?.find(step => step.horizon_hours === 0)?.valid_time;
  if (!base || !Number.isFinite(Date.parse(base))) throw new Error('Exercise requires a valid zero-horizon timestamp');
  const times = [base];
  for (const hotspot of frame.hotspots) {
    const p = hotspot.properties;
    if (!Number.isFinite(Date.parse(p.observed_at))) throw new Error('Invalid exercise observation time');
    p.available_at = p.observed_at;
    times.push(p.observed_at);
  }
  for (const cluster of frame.clusters) if (cluster.properties.last_observed) times.push(cluster.properties.last_observed);
  for (const step of frame.spread) step.issued_at = base;
  const end = Math.max(...times.map(Date.parse));
  if (!Number.isFinite(end)) throw new Error('Invalid exercise simulation clock');
  return {...frame, capturedAt, t: new Date(end).toISOString()};
}
