import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ padding: 24, maxWidth: 640, margin: '40px auto' }} className="card card-b">
        <h2>页面出错了</h2>
        <p className="muted small">{String(this.state.err.message || this.state.err)}</p>
        <button type="button" className="btn primary" onClick={() => { location.hash = '#/dashboard'; location.reload(); }}>回到首页</button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(<Boundary><App /></Boundary>);
