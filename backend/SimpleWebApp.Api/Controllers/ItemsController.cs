using Microsoft.AspNetCore.Mvc;
using SimpleWebApp.Api.Models;

namespace SimpleWebApp.Api.Controllers;

/// <summary>
/// Returns a small in-memory list of items. No database — this is a
/// starter project meant to demo the full stack and the CI/CD pipeline.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class ItemsController : ControllerBase
{
    // Seeded once at startup. In a real app this would be a database.
    private static readonly List<Item> Items = new()
    {
        new Item(1, "Provision IIS server", "Infrastructure", DateTime.UtcNow.AddDays(-5)),
        new Item(2, "Create learner accounts", "Infrastructure", DateTime.UtcNow.AddDays(-4)),
        new Item(3, "Build .NET API", "Backend", DateTime.UtcNow.AddDays(-3)),
        new Item(4, "Build Angular frontend", "Frontend", DateTime.UtcNow.AddDays(-2)),
        new Item(5, "Wire up CI/CD pipeline", "DevOps", DateTime.UtcNow.AddDays(-1)),
    };

    /// <summary>GET /api/items — list all items.</summary>
    [HttpGet]
    public ActionResult<IEnumerable<Item>> GetAll() => Ok(Items);

    /// <summary>GET /api/items/{id} — a single item by id.</summary>
    [HttpGet("{id:int}")]
    public ActionResult<Item> GetById(int id)
    {
        var item = Items.FirstOrDefault(i => i.Id == id);
        return item is null ? NotFound() : Ok(item);
    }
}
