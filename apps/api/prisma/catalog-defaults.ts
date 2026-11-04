import type { PrismaClient } from "@prisma/client";

type CatalogDatabase = Pick<
  PrismaClient,
  | "category"
  | "brand"
  | "catalogProductType"
  | "catalogFeature"
  | "catalogDefaultSuppression"
>;
type CategoryNode = {
  name: string;
  inactive?: boolean;
  children?: CategoryNode[];
};

const categoryTreeText = `
Electronics & Technology
  Mobile Phones & Accessories
    Smartphones
    Cases & Screen Protectors
    Chargers & Cables
  Computers & Tablets
    Laptops
    Desktops
    Tablets
  Computer Components & Peripherals
    Storage & Memory
    Keyboards & Mice
    Monitors & Printers
  Audio & Headphones
    Headphones
    Speakers
    Microphones
  Cameras & Photography
    Cameras
    Lenses
    Tripods & Accessories
  TVs & Home Entertainment
    Televisions
    Projectors
    Streaming Devices
  Gaming
    Consoles
    Games (Gaming)
    Controllers & Accessories
  Networking & Smart Home
    Routers
    Smart Lighting
    Sensors & Security
Clothing, Shoes & Accessories
  Women’s Clothing
    Women’s Tops
    Dresses
    Women’s Bottoms
  Men’s Clothing
    Men’s Tops
    Men’s Bottoms
    Outerwear
  Children’s Clothing
    Baby
    Girls
    Boys
  Shoes
    Casual
    Formal
    Sports
  Bags & Luggage
    Handbags
    Backpacks
    Travel Luggage
  Jewelry & Watches
    Jewelry
    Watches
    Jewelry Accessories
  Eyewear & Accessories
    Eyeglasses
    Sunglasses
    Belts & Hats
Home, Furniture & Garden
  Furniture
    Living Room
    Bedroom
    Dining Room
  Kitchen & Dining
    Cookware
    Tableware
    Small Appliances
  Bedding & Bath
    Bedding
    Towels
    Bathroom Accessories
  Home Décor & Lighting
    Décor
    Lamps
    Ceiling & Outdoor Lighting
  Storage & Organization
    Shelving
    Containers
    Closet Organization
  Garden & Outdoor Living
    Garden Tools
    Outdoor Furniture
    Planters
  Cleaning & Home Care
    Cleaning Tools
    Cleaning Supplies
    Laundry
Beauty & Personal Care
  Skincare
    Cleansers
    Moisturizers
    Sun Care
  Makeup
    Face
    Eyes
    Lips
  Hair Care
    Shampoo & Conditioner
    Styling
    Hair Tools
  Fragrance
    Perfume
    Body Fragrance
    Home Fragrance
  Bath & Body
    Body Wash
    Lotions
    Hand Care
  Grooming
    Shaving
    Beard Care
    Grooming Tools
Health, Fitness & Wellness
  Fitness Equipment
    Strength
    Cardio
    Yoga & Mobility
  Personal Health Devices [inactive]
    Monitors [inactive]
    Thermometers [inactive]
    Personal Care Devices [inactive]
  Mobility & Support [inactive]
    Walking Aids [inactive]
    Braces & Supports [inactive]
    Accessibility [inactive]
  Wellness Accessories
    Sleep
    Relaxation
    Recovery
Sports & Outdoors
  Team Sports
    Football
    Basketball
    Volleyball
  Individual Sports
    Running
    Tennis
    Golf
  Cycling
    Bicycles
    Helmets
    Parts & Accessories
  Camping & Hiking
    Tents
    Packs
    Outdoor Equipment
  Water & Outdoor Recreation
    Swimming
    Fishing
    Recreation Gear
  Sports Apparel
    Clothing
    Footwear
    Protective Gear
Baby & Kids
  Feeding & Nursing
    Bottles
    Feeding Accessories
    Nursing
  Nursery
    Furniture (Nursery)
    Bedding
    Décor
  Strollers & Carriers
    Strollers
    Car Seats
    Carriers
  Baby Care
    Bath
    Diapering
    Safety
  Learning & School
    Learning Toys
    School Supplies
    Children’s Books
Toys & Games
  Building & Creative Toys
    Building Sets
    Craft Kits
    Model Kits
  Dolls & Pretend Play
    Dolls
    Role Play
    Playsets
  Board & Card Games
    Board Games
    Card Games
    Puzzles
  Outdoor Toys
    Ride-Ons
    Sports Toys
    Outdoor Play
  Video Games & Accessories
    Games (Video Games & Accessories)
    Controllers
    Gaming Accessories
Books, Media & Stationery
  Books
    Fiction (Books)
    Nonfiction
    Educational
  Music & Movies
    Music
    Movies
    Physical Media
  Stationery
    Notebooks
    Writing Supplies
    Desk Supplies
  Art Supplies
    Drawing
    Painting
    Paper & Canvas
Grocery & Pantry
  Pantry
    Grains & Pasta
    Canned Goods
    Baking
  Snacks & Confectionery
    Snacks
    Chocolate
    Sweets
  Beverages
    Coffee & Tea
    Soft Drinks
    Water
  Fresh & Chilled Food [inactive]
    Produce [inactive]
    Dairy [inactive]
    Meat & Seafood [inactive]
Pet Supplies
  Food & Treats
    Dogs
    Cats
    Small Animals
  Toys & Enrichment
    Chew Toys
    Interactive Toys
    Training
  Beds & Carriers
    Beds
    Travel Carriers
    Travel Accessories
  Grooming & Care
    Brushes
    Bathing
    Waste Management
  Collars & Leads
    Collars
    Leads
    Harnesses
Automotive & Motorcycle
  Car Parts
    Interior
    Exterior
    Replacement Parts
  Motorcycle Parts
    Protective Gear
    Parts
    Accessories
  Tires & Wheels
    Tires
    Wheels
    Accessories (Tires & Wheels)
  Maintenance & Care
    Tools
    Fluids
    Cleaning & Care
  Vehicle Electronics
    Audio
    Navigation
    Cameras & Sensors
Office, Business & Industrial
  Office Supplies
    Paper
    Writing
    Filing
  Office Furniture
    Desks
    Chairs
    Storage
  Business Technology
    Printers
    Networking
    Accessories (Business Technology)
  Packaging & Shipping
    Boxes
    Mailers
    Labels
  Tools & Industrial Supplies
    Hand Tools
    Safety Equipment
    Workshop Supplies
Arts, Crafts & Hobbies
  Craft Materials
    Paper Crafts
    Beads & Jewelry Making
    Models
  Sewing & Textiles
    Fabric
    Thread
    Sewing Tools
  Painting & Drawing
    Paint
    Brushes
    Drawing Materials
  Musical Instruments
    Instruments
    Audio Equipment
    Accessories (Musical Instruments)
  Collecting & Hobbies
    Models (Collecting)
    Memorabilia
    Hobby Supplies
Software & Digital Products
  Software & Licenses
    Productivity
    Security
    Creative Software
  Online Learning
    Courses
    Tutorials
    Learning Memberships
  Digital Memberships
    Content Access
    Communities
    Subscriptions
  Game & App Content
    Digital Add-ons
    Virtual Content
    App Licenses
Downloadable Files & Digital Media
  E-books & Documents
    Fiction (E-books)
    Education
    Guides
  Templates & Documents
    Business
    Design
    Productivity
  Design Assets
    Fonts
    Graphics
    Presentation Assets
  Audio & Video
    Music (Audio & Video)
    Sound Effects
    Video
  Creative Project Files
    Photography
    3D & CAD
    Source Files
  Printable Products
    Planners
    Worksheets
    Art Prints
Services & Experiences
  Professional Services
    Consulting
    Marketing
    Business Support
  Creative Services
    Design
    Writing
    Photography
  Education & Tutoring
    Academic
    Language
    Skills Training
  Home Services
    Repairs
    Cleaning
    Installation
  Personal Services
    Beauty
    Wellness
    Coaching
  Events & Experiences
    Event Services
    Tickets
    Activities
`;

const brandGroups: Record<string, string> = {
  "Electronics & technology":
    "Apple|Samsung|Sony|Google|Microsoft|Dell|HP|Lenovo|ASUS|Acer|Huawei|Xiaomi|Motorola|Nokia|LG|Panasonic|Philips|Canon|Nikon|Fujifilm|Bose|JBL|Logitech|Anker|Garmin|Nintendo",
  "Fashion & sports":
    "Nike|Adidas|Puma|New Balance|ASICS|Under Armour|Reebok|Levi’s|Uniqlo|Zara|H&M|Converse|Vans|Crocs|Skechers|The North Face|Patagonia|Columbia|Ray-Ban|Casio|Seiko",
  "Home & appliances":
    "IKEA|Dyson|Bosch|Whirlpool|KitchenAid|Electrolux|Haier|Midea|Sharp|Tefal|De’Longhi",
  "Beauty & personal care":
    "L’Oréal Paris|Maybelline|Garnier|Nivea|Dove|CeraVe|Neutrogena|Olay|The Ordinary|Cetaphil|MAC Cosmetics|Estée Lauder|Revlon|Shiseido",
  "Food & beverages":
    "Nestlé|Nescafé|Milo|Maggi|KitKat|Coca-Cola|Sprite|Fanta|Pepsi|Lay’s|Doritos|Oreo|Cadbury|Pringles|Heinz|Knorr|Lipton",
  "Baby, toys & games":
    "LEGO|Mattel|Barbie|Hot Wheels|Fisher-Price|Hasbro|Play-Doh|Nerf|Pampers|Huggies|Johnson’s Baby|Chicco|Graco|Philips Avent",
  "Books & stationery":
    "Penguin Random House|HarperCollins|Pearson|Scholastic|Oxford University Press|Cambridge University Press|Faber-Castell|Staedtler|BIC|Pilot|Moleskine|3M",
  "Automotive & motorcycle":
    "Toyota|Honda|Ford|Nissan|Hyundai|Kia|BMW|Mercedes-Benz|Tesla|Suzuki|Yamaha|Michelin|Bridgestone|Goodyear|Castrol|Shell|Mobil 1",
  "Pet supplies": "Purina|Pedigree|Whiskas|Royal Canin|Hill’s|IAMS|KONG|Trixie",
  "Software & digital products":
    "Adobe|Autodesk|Canva|Intuit|Corel|JetBrains|Zoom|Grammarly|Atlassian|Unity",
};

const defaultProductTypes = [
  {
    id: "ct_physical_default",
    name: "Physical product",
    slug: "physical-product",
    description: "A tangible item delivered to the buyer.",
    requiresShipping: true,
    displayOrder: 0,
  },
  {
    id: "ct_digital_default",
    name: "Digital product",
    slug: "digital-product",
    description: "A non-physical product delivered digitally.",
    requiresShipping: false,
    displayOrder: 10,
  },
  {
    id: "ct_downloadable_default",
    name: "Downloadable files",
    slug: "downloadable-files",
    description: "A digital product with files the buyer can download.",
    requiresShipping: false,
    displayOrder: 20,
  },
  {
    id: "ct_service_default",
    name: "Service",
    slug: "service",
    description: "A service or appointment rather than a shipped item.",
    requiresShipping: false,
    displayOrder: 30,
  },
];

const defaultFeatures: Array<{
  typeSlug: string;
  name: string;
  category?: string[];
}> = [
  {
    typeSlug: "physical-product",
    name: "Handmade",
    category: ["Arts, Crafts & Hobbies", "Craft Materials"],
  },
  {
    typeSlug: "physical-product",
    name: "Wireless",
    category: ["Electronics & Technology", "Audio & Headphones"],
  },
  {
    typeSlug: "physical-product",
    name: "Bluetooth",
    category: ["Electronics & Technology", "Audio & Headphones"],
  },
  {
    typeSlug: "physical-product",
    name: "Rechargeable",
    category: ["Electronics & Technology", "Audio & Headphones"],
  },
  {
    typeSlug: "physical-product",
    name: "Foldable",
    category: ["Sports & Outdoors", "Camping & Hiking"],
  },
  {
    typeSlug: "physical-product",
    name: "Water-resistant",
    category: ["Electronics & Technology", "Cameras & Photography"],
  },
  {
    typeSlug: "physical-product",
    name: "Energy-efficient",
    category: ["Home, Furniture & Garden", "Kitchen & Dining"],
  },
  {
    typeSlug: "physical-product",
    name: "Recycled materials",
    category: ["Clothing, Shoes & Accessories", "Women’s Clothing"],
  },
  ...[
    "Instant access",
    "Cloud-based",
    "Offline access",
    "Multi-device",
    "Updates included",
    "Subscription",
    "Lifetime access",
  ].map((name) => ({ typeSlug: "digital-product", name })),
  ...[
    "Instant download",
    "Editable",
    "Printable",
    "Layered source included",
    "Multiple formats",
    "Commercial license",
    "Updates included",
  ].map((name) => ({ typeSlug: "downloadable-files", name })),
  ...[
    "Remote",
    "In-person",
    "Booking required",
    "Fixed-price",
    "Consultation included",
    "Same-day availability",
    "Travel included",
    "Materials included",
  ].map((name) => ({ typeSlug: "service", name })),
];

function slugBase(value: string) {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[’‘'`]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 140) || "catalog-item"
  );
}

function parseCategoryTree(): CategoryNode[] {
  const rows = categoryTreeText
    .trim()
    .split(/\r?\n/)
    .map((line) => ({
      indent: line.length - line.trimStart().length,
      text: line.trim(),
    }));
  const roots: CategoryNode[] = [];
  const parents: CategoryNode[] = [];
  for (const row of rows) {
    const level = row.indent / 2;
    if (!Number.isInteger(level) || level > 2)
      throw new Error(`Invalid default category depth for ${row.text}`);
    const inactive = row.text.endsWith(" [inactive]");
    const name = row.text.replace(/ \[inactive\]$/, "");
    const node: CategoryNode = { name, inactive };
    if (level === 0) roots.push(node);
    else {
      const parent = parents[level - 1];
      if (!parent)
        throw new Error(`Default category is missing a parent: ${name}`);
      parent.children ??= [];
      parent.children.push(node);
    }
    parents[level] = node;
    parents.length = level + 1;
  }
  return roots;
}

function flattenTree(roots: CategoryNode[]) {
  const entries: Array<{
    node: CategoryNode;
    path: string[];
    parentPath: string[] | null;
  }> = [];
  const visit = (nodes: CategoryNode[], parentPath: string[] | null) => {
    for (const node of nodes) {
      const path = [...(parentPath ?? []), node.name];
      entries.push({ node, path, parentPath });
      visit(node.children ?? [], path);
    }
  };
  visit(roots, null);
  const counts = new Map<string, number>();
  for (const entry of entries)
    counts.set(
      entry.node.name.toLocaleLowerCase("en"),
      (counts.get(entry.node.name.toLocaleLowerCase("en")) ?? 0) + 1,
    );
  return entries.map((entry) => ({
    ...entry,
    displayName:
      (counts.get(entry.node.name.toLocaleLowerCase("en")) ?? 0) > 1
        ? `${entry.node.name} — ${entry.parentPath?.at(-1) ?? "Category"}`
        : entry.node.name,
  }));
}

export async function seedCatalogDefaults(db: CatalogDatabase) {
  const categories = new Map<string, string>();
  const categoryStatuses = new Map<string, string>();
  let categoriesAdded = 0;
  let brandsAdded = 0;
  let productTypesAdded = 0;
  let featuresAdded = 0;
  const activeCategoryPaths = new Set<string>();

  for (const entry of flattenTree(parseCategoryTree())) {
    const pathSlug = entry.path.map(slugBase).join("-");
    const stableId = `catalog-default-category-${pathSlug}`;
    if (
      await db.catalogDefaultSuppression.findUnique({
        where: { defaultKey: stableId },
        select: { id: true },
      })
    )
      continue;
    const parentPath = entry.parentPath?.map(slugBase).join("/") ?? null;
    const parentId = parentPath ? (categories.get(parentPath) ?? null) : null;
    if (parentPath && !parentId) {
      console.warn(
        `Skipping default category “${entry.displayName}”: its parent conflicts with an existing catalog record.`,
      );
      continue;
    }
    const parentStatus = parentPath
      ? (categoryStatuses.get(parentPath) ?? "INACTIVE")
      : "ACTIVE";
    const inactive =
      (entry.node.inactive ?? false) || parentStatus !== "ACTIVE";
    let record = await db.category.findUnique({
      where: { id: stableId },
      select: { id: true, status: true },
    });
    if (!record) {
      const [bySlug, byName] = await Promise.all([
        db.category.findUnique({
          where: { slug: pathSlug },
          select: { id: true, name: true, parentId: true, status: true },
        }),
        db.category.findFirst({
          where: { name: { equals: entry.displayName, mode: "insensitive" } },
          select: { id: true, name: true, parentId: true, status: true },
        }),
      ]);
      const conflict = bySlug ?? byName;
      if (conflict) {
        if (
          conflict.parentId !== parentId ||
          (bySlug && byName && bySlug.id !== byName.id)
        ) {
          console.warn(
            `Skipping default category “${entry.displayName}”: slug or name is already assigned to another catalog record.`,
          );
          continue;
        }
        record = { id: conflict.id, status: conflict.status };
      } else {
        try {
          record = await db.category.create({
            data: {
              id: stableId,
              name: entry.displayName,
              slug: pathSlug,
              parentId,
              status: inactive ? "INACTIVE" : "ACTIVE",
            },
            select: { id: true, status: true },
          });
          categoriesAdded += 1;
        } catch (error) {
          console.warn(
            `Could not seed default category “${entry.displayName}”; existing data was preserved.`,
            error,
          );
          continue;
        }
      }
    }
    const key = entry.path.map(slugBase).join("/");
    categories.set(key, record.id);
    const status = record.status ?? "INACTIVE";
    categoryStatuses.set(key, status);
    if (status === "ACTIVE") activeCategoryPaths.add(key);
  }

  for (const [sector, names] of Object.entries(brandGroups)) {
    for (const name of names.split("|").map((value) => value.trim())) {
      const slug = slugBase(name);
      const id = `catalog-default-brand-${slug}`;
      if (
        await db.catalogDefaultSuppression.findUnique({
          where: { defaultKey: id },
          select: { id: true },
        })
      )
        continue;
      if (await db.brand.findUnique({ where: { id }, select: { id: true } }))
        continue;
      const [bySlug, byName] = await Promise.all([
        db.brand.findUnique({ where: { slug }, select: { id: true } }),
        db.brand.findFirst({
          where: { name: { equals: name, mode: "insensitive" } },
          select: { id: true },
        }),
      ]);
      if (bySlug || byName) {
        console.warn(
          `Skipping starter brand “${name}” (${sector}): a matching name or slug already exists; existing administrator data was preserved.`,
        );
        continue;
      }
      try {
        await db.brand.create({ data: { id, name, slug } });
        brandsAdded += 1;
      } catch (error) {
        console.warn(
          `Could not seed starter brand “${name}”; existing data was preserved.`,
          error,
        );
      }
    }
  }

  const productTypes = new Map<string, string>();
  for (const type of defaultProductTypes) {
    if (
      await db.catalogDefaultSuppression.findUnique({
        where: { defaultKey: type.id },
        select: { id: true },
      })
    )
      continue;
    let record = await db.catalogProductType.findUnique({
      where: { id: type.id },
      select: { id: true },
    });
    if (!record) {
      const [bySlug, byName] = await Promise.all([
        db.catalogProductType.findUnique({
          where: { slug: type.slug },
          select: { id: true },
        }),
        db.catalogProductType.findFirst({
          where: { name: { equals: type.name, mode: "insensitive" } },
          select: { id: true },
        }),
      ]);
      if (bySlug || byName) {
        record = bySlug ?? byName;
        console.warn(
          `Using existing product type “${type.name}” without changing its administrator-managed settings.`,
        );
      } else {
        try {
          record = await db.catalogProductType.create({
            data: type,
            select: { id: true },
          });
          productTypesAdded += 1;
        } catch (error) {
          console.warn(
            `Could not seed product type “${type.name}”; existing data was preserved.`,
            error,
          );
          continue;
        }
      }
    }
    if (!record) continue;
    productTypes.set(type.slug, record.id);
  }

  for (const feature of defaultFeatures) {
    const productTypeId = productTypes.get(feature.typeSlug);
    const categoryPath = feature.category?.map(slugBase).join("/") ?? null;
    const categoryId = categoryPath
      ? (categories.get(categoryPath) ?? null)
      : null;
    if (
      !productTypeId ||
      (categoryPath && (!categoryId || !activeCategoryPaths.has(categoryPath)))
    )
      continue;
    const categorySlug = feature.category?.map(slugBase).join("-");
    const slug = [feature.typeSlug, categorySlug, slugBase(feature.name)]
      .filter(Boolean)
      .join("-")
      .slice(0, 160)
      .replace(/-+$/g, "");
    const id = `catalog-default-feature-${slug}`;
    if (
      await db.catalogDefaultSuppression.findUnique({
        where: { defaultKey: id },
        select: { id: true },
      })
    )
      continue;
    if (
      await db.catalogFeature.findUnique({
        where: { id },
        select: { id: true },
      })
    )
      continue;
    const [bySlug, byName] = await Promise.all([
      db.catalogFeature.findUnique({ where: { slug }, select: { id: true } }),
      db.catalogFeature.findFirst({
        where: {
          name: { equals: feature.name, mode: "insensitive" },
          productTypeId,
          categoryId,
        },
        select: { id: true },
      }),
    ]);
    if (bySlug || byName) {
      console.warn(
        `Skipping starter feature “${feature.name}”: a matching catalog feature already exists.`,
      );
      continue;
    }
    try {
      await db.catalogFeature.create({
        data: { id, name: feature.name, slug, categoryId, productTypeId },
      });
      featuresAdded += 1;
    } catch (error) {
      console.warn(
        `Could not seed starter feature “${feature.name}”; existing data was preserved.`,
        error,
      );
    }
  }

  console.log(
    `Catalog defaults: ${categoriesAdded} categories, ${brandsAdded} brands, ${productTypesAdded} product types, ${featuresAdded} features added.`,
  );
}
