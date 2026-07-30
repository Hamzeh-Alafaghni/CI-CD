using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using SimpleWebApp.Api.Models;
using Xunit;

namespace SimpleWebApp.Api.Tests;

/// <summary>
/// Integration tests that spin up the real API in-memory via
/// WebApplicationFactory. These run in CI on every PR to main.
/// </summary>
public class ApiTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client;

    public ApiTests(WebApplicationFactory<Program> factory)
        => _client = factory.CreateClient();

    [Fact]
    public async Task Health_Returns_Ok()
    {
        var response = await _client.GetAsync("/health");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Items_Returns_Seeded_List()
    {
        var items = await _client.GetFromJsonAsync<List<Item>>("/api/items");
        Assert.NotNull(items);
        Assert.Equal(5, items!.Count);
    }

    [Fact]
    public async Task Item_By_Id_Returns_NotFound_For_Missing()
    {
        var response = await _client.GetAsync("/api/items/999");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
