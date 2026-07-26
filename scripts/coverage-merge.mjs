import path from "node:path";

/**
 * Groups report paths by the collector that produced them.
 *
 * A sharded suite writes one report per shard — apps/gateway/coverage-shard-1..4 —
 * which are the same tool instrumenting the same build, not independent collectors.
 * Merging them as if they were separate collectors keeps every counter that shares
 * a source location once per shard, which multiplies the branch and function
 * denominators by the shard count. Every other report keeps its own group, so a c8
 * report and a vitest report of one package still merge conservatively.
 */
export function collectorGroupKey(coverageFilePath) {
  const reportDir = path.dirname(coverageFilePath);
  const packageDir = path.dirname(reportDir);
  const reportName = path.basename(reportDir).replace(/-shard-\d+$/, "");
  return `${packageDir}::${reportName}`;
}

/**
 * Merges Istanbul coverage for one source file by source location rather than
 * collector-local numeric IDs. Vitest/V8 and c8 can assign different IDs and
 * map shapes to the same file, so numeric-key merging corrupts hit attribution.
 *
 * Where two entries hold several counters that share one source location, the
 * merge cannot tell which counter in one report answers to which in the other, so
 * it keeps each report's copies apart rather than guess. That is right across
 * collectors and wrong across shards of one: a sharded run produces the same
 * instrumentation of the same file several times, so keeping the copies apart
 * counts every ambiguous counter once per shard and inflates the denominator.
 * Pass `sameCollector` when the entries come from one tool measuring one build —
 * the maps then agree counter for counter, so the nth copy of an ambiguous
 * location in one report is the nth copy in the other.
 */
export function mergeCoverageEntries(left, right, options = {}) {
  const sameCollector = options.sameCollector === true;
  const statements = mergeMappedCounters(left, right, {
    mapKey: "statementMap",
    hitKey: "s",
    sameCollector,
    identity: (item) => locationKey(item),
    intrinsicallyAmbiguous: (item) => hasIncompleteLocation(item),
  });
  const functions = mergeMappedCounters(left, right, {
    mapKey: "fnMap",
    hitKey: "f",
    sameCollector,
    identity: (item) => JSON.stringify([String(item?.name ?? ""), locationKey(item?.decl), locationKey(item?.loc)]),
    intrinsicallyAmbiguous: (item) => hasIncompleteLocation(item?.decl) || hasIncompleteLocation(item?.loc),
  });
  const branches = mergeBranchCounters(left, right, { sameCollector });

  return {
    ...left,
    ...right,
    statementMap: statements.coverageMap,
    s: statements.hits,
    l: mergeLineHits(left?.l, right?.l),
    fnMap: functions.coverageMap,
    f: functions.hits,
    branchMap: branches.coverageMap,
    b: branches.hits,
  };
}

function mergeMappedCounters(left, right, options) {
  const records = new Map();
  const order = [];
  const entries = [left, right];
  const ambiguousIdentities = collectAmbiguousIdentities(entries, {
    mapKey: options.mapKey,
    identity: options.identity,
    intrinsicallyAmbiguous: options.intrinsicallyAmbiguous,
  });

  for (const [entryIndex, entry] of entries.entries()) {
    const occurrenceByIdentity = new Map();
    const coverageMap = asRecord(entry?.[options.mapKey]);
    const hits = asRecord(entry?.[options.hitKey]);
    const ids = orderedCoverageIds(coverageMap, hits);

    for (const id of ids) {
      const metadata = coverageMap[id];
      if (!metadata || typeof metadata !== "object") {
        throw new Error(`${options.mapKey} is missing source-location metadata for coverage id ${JSON.stringify(id)}.`);
      }
      const baseIdentity = options.identity(metadata);
      const occurrence = occurrenceByIdentity.get(baseIdentity) ?? 0;
      occurrenceByIdentity.set(baseIdentity, occurrence + 1);
      const identity = ambiguousIdentities.has(baseIdentity)
        ? ambiguousIdentity(baseIdentity, entryIndex, occurrence, options.sameCollector)
        : JSON.stringify([baseIdentity, 0]);
      const hitCount = normalizeHitCount(hits[id], options.hitKey, id);
      const existing = records.get(identity);
      if (existing) {
        existing.hitCount += hitCount;
      } else {
        records.set(identity, {
          metadata: structuredClone(metadata),
          hitCount,
        });
        order.push(identity);
      }
    }
  }

  const coverageMap = {};
  const hits = {};
  for (const [index, identity] of order.entries()) {
    const id = String(index);
    const record = records.get(identity);
    coverageMap[id] = record.metadata;
    hits[id] = record.hitCount;
  }
  return { coverageMap, hits };
}

function ambiguousIdentity(baseIdentity, entryIndex, occurrence, sameCollector) {
  return sameCollector
    ? JSON.stringify([baseIdentity, "occurrence", occurrence])
    : JSON.stringify([baseIdentity, "collector", entryIndex, occurrence]);
}

function mergeBranchCounters(left, right, options = {}) {
  const groups = new Map();
  const groupOrder = [];
  const entries = [left, right];
  const ambiguousIdentities = collectAmbiguousIdentities(entries, {
    mapKey: "branchMap",
    identity: branchIdentity,
    intrinsicallyAmbiguous: (metadata) =>
      hasRepeatedBranchArmLocations(metadata) ||
      hasIncompleteLocation(metadata?.loc) ||
      (Array.isArray(metadata?.locations) && metadata.locations.some((location) => hasIncompleteLocation(location))),
  });

  for (const [entryIndex, entry] of entries.entries()) {
    const occurrenceByIdentity = new Map();
    const branchMap = asRecord(entry?.branchMap);
    const hits = asRecord(entry?.b);
    const ids = orderedCoverageIds(branchMap, hits);

    for (const id of ids) {
      const metadata = branchMap[id];
      if (!metadata || typeof metadata !== "object") {
        throw new Error(`branchMap is missing source-location metadata for coverage id ${JSON.stringify(id)}.`);
      }
      const locations = Array.isArray(metadata.locations) ? metadata.locations : [];
      const armHits = Array.isArray(hits[id]) ? hits[id] : [];
      if (armHits.length > locations.length) {
        throw new Error(
          `branchMap coverage id ${JSON.stringify(id)} has ${armHits.length} hit counters but only ${locations.length} arm locations.`,
        );
      }

      const baseIdentity = branchIdentity(metadata);
      const occurrence = occurrenceByIdentity.get(baseIdentity) ?? 0;
      occurrenceByIdentity.set(baseIdentity, occurrence + 1);
      const identity = ambiguousIdentities.has(baseIdentity)
        ? ambiguousIdentity(baseIdentity, entryIndex, occurrence, options.sameCollector)
        : JSON.stringify([baseIdentity, 0]);
      let group = groups.get(identity);
      if (!group) {
        const { locations: _locations, ...groupMetadata } = structuredClone(metadata);
        group = {
          metadata: groupMetadata,
          arms: new Map(),
          armOrder: [],
        };
        groups.set(identity, group);
        groupOrder.push(identity);
      }

      const armOccurrenceByIdentity = new Map();
      for (const [index, armLocation] of locations.entries()) {
        const baseArmIdentity = branchArmLocationKey(armLocation);
        const armOccurrence = armOccurrenceByIdentity.get(baseArmIdentity) ?? 0;
        armOccurrenceByIdentity.set(baseArmIdentity, armOccurrence + 1);
        const armIdentity = JSON.stringify([baseArmIdentity, armOccurrence]);
        const hitCount = normalizeHitCount(armHits[index], "b", `${id}[${index}]`);
        const existing = group.arms.get(armIdentity);
        if (existing) {
          existing.hitCount += hitCount;
        } else {
          group.arms.set(armIdentity, {
            location: structuredClone(armLocation),
            hitCount,
          });
          group.armOrder.push(armIdentity);
        }
      }
    }
  }

  const coverageMap = {};
  const hits = {};
  for (const [index, identity] of groupOrder.entries()) {
    const id = String(index);
    const group = groups.get(identity);
    coverageMap[id] = {
      ...group.metadata,
      locations: group.armOrder.map((armIdentity) => group.arms.get(armIdentity).location),
    };
    hits[id] = group.armOrder.map((armIdentity) => group.arms.get(armIdentity).hitCount);
  }
  return { coverageMap, hits };
}

function collectAmbiguousIdentities(entries, options) {
  const ambiguous = new Set();
  for (const entry of entries) {
    const counts = new Map();
    const coverageMap = asRecord(entry?.[options.mapKey]);
    for (const metadata of Object.values(coverageMap)) {
      if (!metadata || typeof metadata !== "object") {
        continue;
      }
      const identity = options.identity(metadata);
      counts.set(identity, (counts.get(identity) ?? 0) + 1);
      if (options.intrinsicallyAmbiguous?.(metadata)) {
        ambiguous.add(identity);
      }
    }
    for (const [identity, count] of counts) {
      if (count > 1) {
        ambiguous.add(identity);
      }
    }
  }
  return ambiguous;
}

function branchIdentity(metadata) {
  const armLocations = (Array.isArray(metadata?.locations) ? metadata.locations : [])
    .map((location) => branchArmLocationKey(location))
    .sort();
  return JSON.stringify([
    String(metadata?.type ?? ""),
    locationKey(metadata?.loc),
    sourceLineOrNull(metadata?.line),
    armLocations,
  ]);
}

function hasRepeatedBranchArmLocations(metadata) {
  const locations = Array.isArray(metadata?.locations) ? metadata.locations : [];
  const identities = locations.map((location) => branchArmLocationKey(location));
  return new Set(identities).size !== identities.length;
}

function hasIncompleteLocation(location) {
  return (
    location?.start?.line === null ||
    location?.start?.line === undefined ||
    location?.start?.column === null ||
    location?.start?.column === undefined ||
    location?.end?.line === null ||
    location?.end?.line === undefined ||
    location?.end?.column === null ||
    location?.end?.column === undefined
  );
}

function mergeLineHits(left, right) {
  const merged = new Map();
  for (const source of [asRecord(left), asRecord(right)]) {
    for (const [line, rawHitCount] of Object.entries(source)) {
      const numericLine = Number(line);
      if (!Number.isInteger(numericLine) || numericLine <= 0) {
        throw new Error(`Line coverage contains invalid line number ${JSON.stringify(line)}.`);
      }
      const hitCount = normalizeHitCount(rawHitCount, "l", line);
      merged.set(numericLine, (merged.get(numericLine) ?? 0) + hitCount);
    }
  }

  return Object.fromEntries([...merged.entries()].sort(([leftLine], [rightLine]) => leftLine - rightLine));
}

function orderedCoverageIds(coverageMap, hits) {
  const ids = new Set([...Object.keys(coverageMap), ...Object.keys(hits)]);
  return [...ids].sort(compareCoverageIds);
}

function compareCoverageIds(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isInteger(leftNumber) && Number.isInteger(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right);
}

function normalizeHitCount(value, mapName, id) {
  if (value === undefined) {
    return 0;
  }
  const count = Number(value);
  if (!Number.isFinite(count)) {
    throw new Error(`${mapName} coverage id ${JSON.stringify(id)} has invalid hit count ${JSON.stringify(value)}.`);
  }
  // V8 source-map remapping can emit negative branch counters. Coverage
  // semantics only distinguish positive hits, so keep those artifacts
  // conservative instead of allowing a negative value to cancel real hits.
  return Math.max(0, count);
}

function locationKey(location) {
  if (!location || typeof location !== "object" || Array.isArray(location)) {
    throw new Error("Coverage map is missing a valid source location.");
  }
  return JSON.stringify([
    sourceLine(location?.start?.line),
    sourceColumnOrNull(location?.start?.column),
    sourceLine(location?.end?.line),
    sourceColumnOrNull(location?.end?.column),
  ]);
}

function branchArmLocationKey(location) {
  if (!location || typeof location !== "object" || Array.isArray(location)) {
    throw new Error("Coverage branch map is missing a valid arm location.");
  }
  if (!isPlainLocationEndpoint(location.start) || !isPlainLocationEndpoint(location.end)) {
    throw new Error("Coverage branch arm must contain valid start and end locations.");
  }
  const coordinates = [location.start.line, location.start.column, location.end.line, location.end.column];
  if (coordinates.every((value) => value === null || value === undefined)) {
    return JSON.stringify(["implicit-unlocated-arm"]);
  }
  if (
    location.start.line === null ||
    location.start.line === undefined ||
    location.end.line === null ||
    location.end.line === undefined
  ) {
    throw new Error("Coverage branch map contains a partially located branch arm.");
  }
  return JSON.stringify([
    sourceLine(location.start.line),
    sourceColumnOrNull(location.start.column),
    sourceLine(location.end.line),
    sourceColumnOrNull(location.end.column),
  ]);
}

function isPlainLocationEndpoint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sourceLineOrNull(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return sourceLine(value);
}

function sourceLine(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Coverage map contains invalid source line ${JSON.stringify(value)}.`);
  }
  return value;
}

function sourceColumnOrNull(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Coverage map contains invalid source column ${JSON.stringify(value)}.`);
  }
  return value;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
