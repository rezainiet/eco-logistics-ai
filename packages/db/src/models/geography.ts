import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Bangladesh address gazetteer — operational data, not engineering data.
 *
 * Phase 2 substrate for `lib/address-canonical.ts`. One row per geographic
 * unit (division / district / thana / area), keyed on a canonical lowercase
 * string. The `aliases` array carries every plausible spelling we want to
 * collapse into the canonical (Banglish, Bangla, common misspellings,
 * abbreviations). Cap is enforced at the schema level so an admin UI add
 * can't grow the array unbounded.
 *
 * Why a Mongoose collection (and not a code constant like
 * `lib/thana-lexicon.ts`):
 *   - Operators add aliases / new thanas without a redeploy.
 *   - Versioned data asset; we can ship Geography updates independently
 *     of the API.
 *   - Backfill / migration tooling can target the gazetteer directly.
 *
 * Read pattern: every API instance loads the full collection ONCE on first
 * use into an in-process Map (see `apps/api/src/lib/gazetteer.ts`), with a
 * 5-minute TTL refresh. Per-request canonicalisation does NOT hit Mongo.
 *
 * Replay-safety: this collection is a derivation source, never the
 * authoritative state. Existing CanonicalAddress rows on `Order.source`
 * remain valid even if a gazetteer alias is later removed — the
 * `pipelineVersion` field on each CanonicalAddress pins it to the data
 * shape of its computation moment.
 */

export const GAZETTEER_LEVELS = ["division", "district", "thana", "area"] as const;
export type GazetteerLevel = (typeof GAZETTEER_LEVELS)[number];

export const GAZETTEER_SOURCES = [
  "seed",
  "operator",
  "courier_hub_import",
] as const;
export type GazetteerSource = (typeof GAZETTEER_SOURCES)[number];

/** Cap on stored aliases per row. Bounds operator-UI growth and document size. */
export const GEOGRAPHY_ALIAS_CAP = 50;

/** Cap on stored knownRoads. Optional list of high-frequency road names per
 *  thana — fed by future courier-hub imports. Bounded for the same reasons. */
export const GEOGRAPHY_KNOWN_ROADS_CAP = 200;

const geographySchema = new Schema(
  {
    /** division | district | thana | area. Determines hierarchy semantics. */
    level: { type: String, enum: GAZETTEER_LEVELS, required: true },

    /**
     * Canonical lowercase form. Matches `address-canonical.ts`'s output for
     * the corresponding level (e.g. "dhaka", "dhanmondi", "panchlaish").
     * Combined with `level` to form the unique compound index.
     */
    canonical: { type: String, required: true, trim: true, lowercase: true, maxlength: 100 },

    /**
     * Canonical of the parent level (district for thana; thana for area;
     * undefined for division and root district). Used to disambiguate
     * homonyms — e.g. "Kotwali" exists in Dhaka, Chittagong, Comilla.
     */
    parent: { type: String, trim: true, lowercase: true, maxlength: 100 },

    /**
     * All alternative spellings + transliterations. Lowercased at write time
     * (mongoose `lowercase: true` on the schema). The `address-canonical`
     * pipeline tokenizes input identically so equality is structural.
     *
     * Cap (`GEOGRAPHY_ALIAS_CAP`) bounds doc size. Validators enforce both
     * the count and per-alias length so a misbehaving operator UI cannot
     * grow rows past a safe ceiling.
     */
    aliases: {
      type: [String],
      default: [],
      validate: [
        {
          validator: (arr: unknown) =>
            Array.isArray(arr) && arr.length <= GEOGRAPHY_ALIAS_CAP,
          message: `aliases cannot exceed ${GEOGRAPHY_ALIAS_CAP} entries`,
        },
        {
          validator: (arr: unknown) =>
            Array.isArray(arr) &&
            arr.every(
              (s) => typeof s === "string" && s.length > 0 && s.length <= 100,
            ),
          message: "every alias must be 1..100 chars",
        },
      ],
    },

    /**
     * Optional pre-loaded list of high-frequency roads / sub-areas for this
     * thana. Phase 2 does not consume this; future courier-lane intelligence
     * (Phase 3) will use it as a confidence boost. Capped.
     */
    knownRoads: {
      type: [String],
      default: undefined,
      validate: {
        validator: (arr: unknown) =>
          arr === undefined ||
          (Array.isArray(arr) && arr.length <= GEOGRAPHY_KNOWN_ROADS_CAP),
        message: `knownRoads cannot exceed ${GEOGRAPHY_KNOWN_ROADS_CAP} entries`,
      },
    },

    /**
     * Pipeline version this row is compatible with. Pinned to the
     * `ADDRESS_PIPELINE_VERSION` literal at seed time. A future schema
     * migration would write rows under a new version while leaving v1
     * rows readable — the canonicaliser checks the version when loading
     * the gazetteer and refuses to mix shapes.
     */
    pipelineVersion: { type: String, required: true, trim: true, maxlength: 16 },

    /** Where this row originated. Useful for audit + future imports. */
    source: { type: String, enum: GAZETTEER_SOURCES, required: true },
  },
  { timestamps: true },
);

/** Primary lookup + uniqueness — every read goes through this index. */
geographySchema.index({ level: 1, canonical: 1 }, { unique: true });
/** Multikey alias lookup — used by the loader to build the in-memory map. */
geographySchema.index({ aliases: 1 });
/** Hierarchy queries (e.g. "all thanas under district X"). */
geographySchema.index({ parent: 1, level: 1 });

export type Geography = InferSchemaType<typeof geographySchema> & {
  _id: Types.ObjectId;
};

export const Geography: Model<Geography> =
  (models.Geography as Model<Geography>) ||
  model<Geography>("Geography", geographySchema);
