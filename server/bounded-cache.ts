/** Small TTL cache. Expired and oldest entries are removed on every write. */
export class BoundedCache<T> {
  private entries = new Map<string, {value:T; expiresAt:number}>();
  constructor(private readonly capacity:number, private readonly ttlMs:number) {}
  get(key:string): T | undefined {
    const entry=this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt<=Date.now()) { this.entries.delete(key); return undefined; }
    return entry.value;
  }
  set(key:string,value:T):void {
    const now=Date.now();
    for(const [id,entry] of this.entries) if(entry.expiresAt<=now) this.entries.delete(id);
    this.entries.delete(key);
    this.entries.set(key,{value,expiresAt:now+this.ttlMs});
    while(this.entries.size>this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }
}
