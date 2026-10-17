/** Minimal Prometheus metrics (text exposition format) for /metrics. */
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5];
const requests = new Map<string, number>();
const durations = new Map<string, { buckets: number[]; sum: number; count: number }>();
const counters = new Map<string, number>();

export function observeRequest(method: string, route: string, status: number, seconds: number) {
  const k = `method="${method}",route="${route}",status="${status}"`;
  requests.set(k, (requests.get(k) ?? 0) + 1);
  const dk = `method="${method}",route="${route}"`;
  const d = durations.get(dk) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
  BUCKETS.forEach((b, i) => {
    if (seconds <= b) d.buckets[i]++;
  });
  d.sum += seconds;
  d.count++;
  durations.set(dk, d);
}

export function inc(name: string, labels = '', by = 1) {
  const k = `${name}{${labels}}`;
  counters.set(k, (counters.get(k) ?? 0) + by);
}

export function renderMetrics(gauges: Record<string, number>): string {
  const out: string[] = ['# TYPE http_requests_total counter'];
  for (const [k, v] of requests) out.push(`http_requests_total{${k}} ${v}`);
  out.push('# TYPE http_request_duration_seconds histogram');
  for (const [k, d] of durations) {
    BUCKETS.forEach((b, i) => out.push(`http_request_duration_seconds_bucket{${k},le="${b}"} ${d.buckets[i]}`));
    out.push(`http_request_duration_seconds_bucket{${k},le="+Inf"} ${d.count}`);
    out.push(`http_request_duration_seconds_sum{${k}} ${d.sum.toFixed(4)}`);
    out.push(`http_request_duration_seconds_count{${k}} ${d.count}`);
  }
  for (const [k, v] of counters) out.push(`${k} ${v}`);
  for (const [k, v] of Object.entries(gauges)) out.push(`# TYPE ${k} gauge`, `${k} ${v}`);
  return out.join('\n') + '\n';
}
