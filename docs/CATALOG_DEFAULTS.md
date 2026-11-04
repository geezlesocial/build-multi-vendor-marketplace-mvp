# Curated catalog starter defaults

The defaults support a useful first catalog without claiming to be a complete global directory. They are installed by `npm run db:seed`; seed runs are additive, idempotent, and do not update existing administrator-managed rows. Removal of a seeded row is retained through a suppression marker. Existing records that conflict by name or slug are preserved and reported for administrator review.

## Category roots

The default taxonomy is nested to no more than three levels (root, child, optional subcategory). The 17 roots are:

1. Electronics & Technology
2. Clothing, Shoes & Accessories
3. Home, Furniture & Garden
4. Beauty & Personal Care
5. Health, Fitness & Wellness
6. Sports & Outdoors
7. Baby & Kids
8. Toys & Games
9. Books, Media & Stationery
10. Grocery & Pantry
11. Pet Supplies
12. Automotive & Motorcycle
13. Office, Business & Industrial
14. Arts, Crafts & Hobbies
15. Software & Digital Products
16. Downloadable Files & Digital Media
17. Services & Experiences

Each root has focused child groups and optional subcategories in `apps/api/prisma/catalog-defaults.ts`. Category names are unique in the marketplace; repeated labels are qualified by their parent where necessary. Personal health devices, mobility/support categories, and fresh/chilled food start inactive to avoid implying regulatory, cold-chain, or handling readiness. Administrators must review applicable requirements before activating them.

The existing canonical product types remain: Physical product, Digital product, Downloadable files, and Service. Starter selectable features are optional, scoped to compatible product types and (where useful) categories. They are not a substitute for structured product attributes such as size, color, or variant data.

## Starter brands by sector

These are recognizable brand-name examples supplied for catalog setup and review. They are stored once each with normalized unique slugs, not duplicated by category. Product brand selection remains optional, so null/unbranded listings continue to work.

- **Electronics & technology:** Apple, Samsung, Sony, Google, Microsoft, Dell, HP, Lenovo, ASUS, Acer, Huawei, Xiaomi, Motorola, Nokia, LG, Panasonic, Philips, Canon, Nikon, Fujifilm, Bose, JBL, Logitech, Anker, Garmin, Nintendo.
- **Fashion & sports:** Nike, Adidas, Puma, New Balance, ASICS, Under Armour, Reebok, Levi’s, Uniqlo, Zara, H&M, Converse, Vans, Crocs, Skechers, The North Face, Patagonia, Columbia, Ray-Ban, Casio, Seiko.
- **Home & appliances:** IKEA, Dyson, Bosch, Whirlpool, KitchenAid, Electrolux, Haier, Midea, Sharp, Tefal, De’Longhi.
- **Beauty & personal care:** L’Oréal Paris, Maybelline, Garnier, Nivea, Dove, CeraVe, Neutrogena, Olay, The Ordinary, Cetaphil, MAC Cosmetics, Estée Lauder, Revlon, Shiseido.
- **Food & beverages:** Nestlé, Nescafé, Milo, Maggi, KitKat, Coca-Cola, Sprite, Fanta, Pepsi, Lay’s, Doritos, Oreo, Cadbury, Pringles, Heinz, Knorr, Lipton.
- **Baby, toys & games:** LEGO, Mattel, Barbie, Hot Wheels, Fisher-Price, Hasbro, Play-Doh, Nerf, Pampers, Huggies, Johnson’s Baby, Chicco, Graco, Philips Avent.
- **Books & stationery:** Penguin Random House, HarperCollins, Pearson, Scholastic, Oxford University Press, Cambridge University Press, Faber-Castell, Staedtler, BIC, Pilot, Moleskine, 3M.
- **Automotive & motorcycle:** Toyota, Honda, Ford, Nissan, Hyundai, Kia, BMW, Mercedes-Benz, Tesla, Suzuki, Yamaha, Michelin, Bridgestone, Goodyear, Castrol, Shell, Mobil 1.
- **Pet supplies:** Purina, Pedigree, Whiskas, Royal Canin, Hill’s, IAMS, KONG, Trixie.
- **Software & digital products:** Adobe, Autodesk, Canva, Intuit, Corel, JetBrains, Zoom, Grammarly, Atlassian, Unity.

Starter names do not indicate marketplace endorsement, inventory availability, or brand ownership. The marketplace does not bundle or scrape logos. Brand and category images default to generated initials; uploaded artwork must go through the existing authorized upload, validation, malware scan, and approval workflow.
