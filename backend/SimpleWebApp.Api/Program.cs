// ============================================================
// Program.cs — ASP.NET Core Web API entry point (.NET 8)
// ============================================================
// Minimal hosting model. Registers controllers, Swagger, CORS,
// a health endpoint, and serves under IIS via the ASP.NET Core
// Module (see web.config).
// ============================================================

var builder = WebApplication.CreateBuilder(args);

// ---- Services ----
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// CORS — the Angular frontend calls this API from a different origin.
// Allowed origins come from configuration (appsettings.{Environment}.json)
// so each environment (dev/staging/prod) can whitelist its own site URL.
const string CorsPolicy = "FrontendCors";
var allowedOrigins = builder.Configuration
    .GetSection("Cors:AllowedOrigins")
    .Get<string[]>() ?? new[] { "http://localhost:4200" };

builder.Services.AddCors(options =>
{
    options.AddPolicy(CorsPolicy, policy =>
        policy.WithOrigins(allowedOrigins)
              .AllowAnyHeader()
              .AllowAnyMethod());
});

var app = builder.Build();

// ---- Pipeline ----
// Swagger UI is handy in every environment for this learning project.
app.UseSwagger();
app.UseSwaggerUI();

app.UseCors(CorsPolicy);
app.UseAuthorization();

app.MapControllers();

// Lightweight health/liveness endpoint used by the pipeline & monitoring.
app.MapGet("/health", () => Results.Ok(new
{
    status = "healthy",
    environment = app.Environment.EnvironmentName,
    version = typeof(Program).Assembly.GetName().Version?.ToString() ?? "unknown",
    timestampUtc = DateTime.UtcNow
}));

app.Run();

// Exposed so the test project can reference the entry point.
public partial class Program { }
