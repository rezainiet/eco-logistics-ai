<?php
/**
 * Snippet:    3 Digit Lock - Tier Quantity Pricing (CartFlows-compatible, math-consistent)
 * Site:       arabiansultanbd.com
 * Installed:  via WPCode -> Snippets (snippet ID 844)
 *
 * Logic:
 *   qty 1   -> 350 BDT each (no discount)
 *   qty 2+  -> 300 BDT each effective (50 BDT off per unit, shown as bulk discount line)
 *
 * Counts ALL variations of product 417 together (Blue + Red + Silver),
 * so 1 Blue + 1 Red = qty 2 -> bulk discount applies.
 *
 * Implementation:
 *   - Adds a single NEGATIVE fee line "Bulk discount" of (50 BDT * total qty)
 *     when total qty >= 2. This is the only price adjustment - line items
 *     stay at the original 350 BDT each so the math the customer sees is
 *     always consistent: line subtotals add up to Subtotal, then the
 *     discount line subtracts cleanly, then courier is added.
 *   - We do NOT override the per-line price or per-line subtotal display.
 *     CartFlows ignores set_price() for the Subtotal line, so showing
 *     300 per line while Subtotal stayed 700 caused customer confusion
 *     ("how does 300 + 300 = 700?"). The fee-only approach prevents that.
 *
 * Customer sees, with qty 2:
 *   3 Digit Lock - নীল    × 2    700৳
 *   Subtotal                       700৳
 *   Bulk discount                 -100৳
 *   Shipping                        70৳
 *   Total                          670৳
 *
 * To extend to another product later, add its parent product ID to the
 * array returned by asbd_3dl_get_target_parents().
 */

if ( ! defined( 'ABSPATH' ) ) { exit; }

if ( ! function_exists( 'asbd_3dl_get_target_parents' ) ) {

    function asbd_3dl_get_target_parents() {
        return array( 417 ); // 3 Digit Lock (variable product)
    }

    /**
     * Adds a negative fee equal to (price_single - price_bulk) * total_qty
     * when the cart qualifies for the bulk price.
     */
    function asbd_3dl_apply_discount_fee( $cart ) {
        if ( is_admin() && ! defined( 'DOING_AJAX' ) ) { return; }
        if ( ! is_a( $cart, 'WC_Cart' ) ) { return; }

        $price_single   = 350;
        $price_bulk     = 300;
        $bulk_threshold = 2;
        $targets        = asbd_3dl_get_target_parents();

        $total_qty = 0;
        foreach ( $cart->get_cart() as $cart_item ) {
            $pid = isset( $cart_item['product_id'] ) ? (int) $cart_item['product_id'] : 0;
            if ( in_array( $pid, $targets, true ) ) {
                $total_qty += (int) $cart_item['quantity'];
            }
        }

        if ( $total_qty < $bulk_threshold ) {
            return;
        }

        $discount = ( $price_single - $price_bulk ) * $total_qty;

        if ( $discount > 0 ) {
            $cart->add_fee( 'Bulk discount (২+ ইউনিটে প্রতি ইউনিট ৫০৳ ছাড়)', -1 * $discount, false );
        }
    }
    add_action( 'woocommerce_cart_calculate_fees', 'asbd_3dl_apply_discount_fee', 10, 1 );
}
