# WinCC OA Datapoint Addressing

## Important Note on Datapoint Element Access

In WinCC OA, when addressing datapoints that do not have explicit elements, the syntax requires a **trailing dot** (`.`) at the end of the datapoint name.

### Example

- Datapoint with elements: `System1:MonsterMQ_Vogler/home/Original/Tasmota/14CF4C/ApparentPower.value`
- Datapoint without elements: `System1:MonsterMQ_Vogler/home/Original/Tasmota/14CF4C/ApparentPower.`

The trailing dot indicates accessing the base datapoint without specifying a particular element.

### API Usage

When using WinCC OA GraphQL API functions (like `setAlias`, `setDescription`, etc.) with datapoints that don't have elements, use the format with the trailing dot:

```
System1:DataPointName.
```

This is especially important when working with mutation operations on the API.

