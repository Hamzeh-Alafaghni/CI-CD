import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [RouterLink],
  template: `
    <section class="hero">
      <h1>Welcome 👋</h1>
      <p class="lead">
        A simple full-stack starter: an <strong>Angular</strong> frontend talking to a
        <strong>.NET&nbsp;8</strong> API, shipped to <strong>IIS</strong> through a
        <strong>GitHub Actions</strong> CI/CD pipeline.
      </p>
      <div class="cards">
        <div class="card">
          <h3>Frontend</h3>
          <p>Angular standalone components with routing across Home, About, and Data.</p>
        </div>
        <div class="card">
          <h3>Backend</h3>
          <p>ASP.NET Core Web API exposing <code>/api/items</code> and <code>/health</code>.</p>
        </div>
        <div class="card">
          <h3>Pipeline</h3>
          <p>Build, test, version, tag, release, and deploy per environment.</p>
        </div>
      </div>
      <a class="btn" routerLink="/data">See live data from the API →</a>
    </section>
  `,
})
export class HomeComponent {}
