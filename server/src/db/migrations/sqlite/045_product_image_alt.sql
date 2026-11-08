-- Product catalog block: alt text for the product image (the first entry of images_json), shown on the cards of the block. Empty means decorative.
ALTER TABLE products ADD COLUMN image_alt TEXT NOT NULL DEFAULT '';
