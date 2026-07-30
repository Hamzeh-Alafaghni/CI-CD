namespace SimpleWebApp.Api.Models;

/// <summary>
/// A simple demo record returned by the API and rendered on the
/// Angular "Data" page.
/// </summary>
public record Item(int Id, string Name, string Category, DateTime CreatedUtc);
