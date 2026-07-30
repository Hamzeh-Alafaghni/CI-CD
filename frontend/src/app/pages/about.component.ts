import { Component } from '@angular/core';
import { environment } from '../../environments/environment';

@Component({
  selector: 'app-about',
  standalone: true,
  template: `
    <section class="panel">
      <h1>About</h1>
      <p>
        This project is a learning sandbox that demonstrates how the pieces of a
        modern web deployment fit together.
      </p>
      <ul>
        <li><strong>Frontend:</strong> Angular 18 (standalone APIs)</li>
        <li><strong>Backend:</strong> ASP.NET Core Web API on .NET 8</li>
        <li><strong>Host:</strong> IIS on Windows Server 2022 (AWS EC2)</li>
        <li><strong>CI/CD:</strong> GitHub Actions — CI on PRs, release on main, manual environment deploys</li>
      </ul>
      <p class="muted">Current build environment: <strong>{{ environment.name }}</strong></p>
    </section>
  `,
})
export class AboutComponent {
  protected readonly environment = environment;
}
