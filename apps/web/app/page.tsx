export default function HomePage() {
  return (
    <main className="shell">
      <section className="status-card" aria-labelledby="page-title">
        <p className="eyebrow">Working prototype</p>
        <h1 id="page-title">SnapFlow</h1>
        <p className="summary">The camera-to-action workspace is being built.</p>
        <dl className="status-list">
          <div>
            <dt>Web</dt>
            <dd>Online</dd>
          </div>
          <div>
            <dt>Mode</dt>
            <dd>Mock first</dd>
          </div>
          <div>
            <dt>Images</dt>
            <dd>Browser only</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
