export default function Header({ title, subtitle }) {
  return (
    <header className="header-shell">
      <div>
<h1>{title}</h1>
        <p className="header-subtitle">{subtitle || 'Operational dashboard for content planning, generation, and publishing.'}</p>
      </div>
    </header>
  );
}

