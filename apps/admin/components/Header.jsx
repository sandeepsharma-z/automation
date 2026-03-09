export default function Header({ title, subtitle }) {
  return (
    <header className="header-shell">
      <div>
        <p className="header-kicker">ContentOps AI Workspace</p>
        <h1>{title}</h1>
        <p className="header-subtitle">{subtitle || 'Operational dashboard for content planning, generation, and publishing.'}</p>
      </div>
    </header>
  );
}

