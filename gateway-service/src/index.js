const express = require("express");
const clients = require("./clients");
const { computePurchaseSplit } = require("./pricing");

const app = express();
app.use(express.json());

function requireUsername(req, res) {
  const username = req.header("X-User-Name");
  if (!username) {
    res.status(400).json({ message: "X-User-Name header is required" });
    return null;
  }
  return username;
}

async function enrichTickets(tickets) {
  const flightCache = new Map();
  const results = [];
  for (const ticket of tickets) {
    if (!flightCache.has(ticket.flightNumber)) {
      flightCache.set(ticket.flightNumber, await clients.getFlight(ticket.flightNumber));
    }
    const flight = flightCache.get(ticket.flightNumber) || {};
    results.push({
      ticketUid: ticket.ticketUid,
      flightNumber: ticket.flightNumber,
      fromAirport: flight.fromAirport,
      toAirport: flight.toAirport,
      date: flight.date,
      price: ticket.price,
      status: ticket.status,
    });
  }
  return results;
}

app.get("/manage/health", (req, res) => {
  res.sendStatus(200);
});

app.get("/api/v1/flights", async (req, res, next) => {
  try {
    const flights = await clients.listFlights(req.query.page, req.query.size);
    res.json(flights);
  } catch (err) {
    next(err);
  }
});

app.get("/api/v1/tickets", async (req, res, next) => {
  try {
    const username = requireUsername(req, res);
    if (!username) return;

    const tickets = await clients.listTickets(username);
    res.json(await enrichTickets(tickets));
  } catch (err) {
    next(err);
  }
});

app.get("/api/v1/tickets/:ticketUid", async (req, res, next) => {
  try {
    const username = requireUsername(req, res);
    if (!username) return;

    const ticket = await clients.getTicket(username, req.params.ticketUid);
    if (!ticket) {
      return res.status(404).json({ message: "Ticket not found" });
    }
    const [enriched] = await enrichTickets([ticket]);
    res.json(enriched);
  } catch (err) {
    next(err);
  }
});

app.post("/api/v1/tickets", async (req, res, next) => {
  try {
    const username = requireUsername(req, res);
    if (!username) return;

    const { flightNumber, price, paidFromBalance } = req.body || {};
    if (typeof flightNumber !== "string" || flightNumber.trim() === "" || typeof price !== "number") {
      return res.status(400).json({
        message: "Validation error",
        errors: [{ field: "flightNumber/price", error: "must be provided" }],
      });
    }

    const flight = await clients.getFlight(flightNumber);
    if (!flight) {
      return res.status(400).json({
        message: "Validation error",
        errors: [{ field: "flightNumber", error: "flight not found" }],
      });
    }

    const privilege = await clients.getPrivilege(username);
    const { paidByBonuses, paidByMoney } = computePurchaseSplit(
      privilege.balance,
      price,
      Boolean(paidFromBalance)
    );

    const ticket = await clients.createTicket({
      username,
      flightNumber,
      price,
    });

    const updatedPrivilege =
      paidByBonuses > 0
        ? await clients.debitPrivilege(username, ticket.ticketUid, paidByBonuses)
        : await clients.fillPrivilege(username, ticket.ticketUid, Math.round(price * 0.1));

    res.json({
      ticketUid: ticket.ticketUid,
      flightNumber: flight.flightNumber,
      fromAirport: flight.fromAirport,
      toAirport: flight.toAirport,
      date: flight.date,
      price,
      paidByMoney,
      paidByBonuses,
      status: ticket.status,
      privilege: { balance: updatedPrivilege.balance, status: updatedPrivilege.status },
    });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/v1/tickets/:ticketUid", async (req, res, next) => {
  try {
    const username = requireUsername(req, res);
    if (!username) return;

    const ticket = await clients.getTicket(username, req.params.ticketUid);
    if (!ticket) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    await clients.cancelTicket(username, req.params.ticketUid);
    await clients.cancelPrivilege(username, req.params.ticketUid);

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.get("/api/v1/me", async (req, res, next) => {
  try {
    const username = requireUsername(req, res);
    if (!username) return;

    const [tickets, privilege] = await Promise.all([
      clients.listTickets(username),
      clients.getPrivilege(username),
    ]);

    res.json({
      tickets: await enrichTickets(tickets),
      privilege: { balance: privilege.balance, status: privilege.status },
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/v1/privilege", async (req, res, next) => {
  try {
    const username = requireUsername(req, res);
    if (!username) return;

    const privilege = await clients.getPrivilege(username);
    res.json(privilege);
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Internal error" });
});

const PORT = process.env.PORT || 8080;

if (require.main === module) {
  app.listen(PORT, () => console.log(`gateway-service listening on ${PORT}`));
}

module.exports = app;
