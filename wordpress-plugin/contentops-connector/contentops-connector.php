<?php
/**
 * Plugin Name: ContentOps Connector
 * Description: Token-based connector for ContentOps publishing (media, SEO, taxonomies).
 * Version: 1.0.0
 * Author: ContentOps
 */

if (!defined('ABSPATH')) {
    exit;
}

final class ContentOpsConnector {
    private const OPTION_TOKEN = 'contentops_connector_token';
    private const OPTION_ENABLED = 'contentops_connector_enabled';
    private const OPTION_ALLOWED_ORIGINS = 'contentops_connector_allowed_origins';
    private const OPTION_RATE_LIMIT = 'contentops_connector_rate_limit';
    private const TRANSIENT_REVEAL_PREFIX = 'contentops_connector_reveal_';

    public function __construct() {
        add_action('admin_menu', [$this, 'register_admin_menu']);
        add_action('admin_init', [$this, 'register_settings']);
        add_action('admin_post_contentops_connector_regen_token', [$this, 'handle_regenerate_token']);
        add_action('rest_api_init', [$this, 'register_rest_routes']);
        add_action('rest_pre_serve_request', [$this, 'maybe_send_cors_headers'], 10, 4);
    }

    public function register_admin_menu(): void {
        add_options_page(
            'ContentOps Connector',
            'ContentOps Connector',
            'manage_options',
            'contentops-connector',
            [$this, 'render_settings_page']
        );
    }

    public function register_settings(): void {
        register_setting('contentops_connector', self::OPTION_ENABLED, [
            'type' => 'boolean',
            'sanitize_callback' => static fn($v) => (bool) $v,
            'default' => true,
        ]);
        register_setting('contentops_connector', self::OPTION_ALLOWED_ORIGINS, [
            'type' => 'string',
            'sanitize_callback' => 'sanitize_textarea_field',
            'default' => '',
        ]);
        register_setting('contentops_connector', self::OPTION_RATE_LIMIT, [
            'type' => 'integer',
            'sanitize_callback' => static fn($v) => max(1, (int) $v),
            'default' => 60,
        ]);
    }

    public function render_settings_page(): void {
        if (!current_user_can('manage_options')) {
            return;
        }
        $current_user_id = get_current_user_id();
        $reveal_key = self::TRANSIENT_REVEAL_PREFIX . $current_user_id;
        $revealed_token = (string) get_transient($reveal_key);
        if ($revealed_token !== '') {
            delete_transient($reveal_key);
        }
        $enabled = (bool) get_option(self::OPTION_ENABLED, true);
        $origins = (string) get_option(self::OPTION_ALLOWED_ORIGINS, '');
        $token = (string) get_option(self::OPTION_TOKEN, '');
        $rate_limit = (int) get_option(self::OPTION_RATE_LIMIT, 60);
        ?>
        <div class="wrap">
            <h1>ContentOps Connector</h1>
            <form method="post" action="options.php">
                <?php settings_fields('contentops_connector'); ?>
                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row">Enable connector</th>
                        <td><input type="checkbox" name="<?php echo esc_attr(self::OPTION_ENABLED); ?>" value="1" <?php checked($enabled); ?> /></td>
                    </tr>
                    <tr>
                        <th scope="row">Allowed origins (optional)</th>
                        <td>
                            <textarea name="<?php echo esc_attr(self::OPTION_ALLOWED_ORIGINS); ?>" rows="5" cols="70" placeholder="https://app.example.com&#10;https://admin.example.com"><?php echo esc_textarea($origins); ?></textarea>
                            <p class="description">Leave empty for same-origin only.</p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Rate limit (requests per minute per IP)</th>
                        <td><input type="number" min="1" max="1000" name="<?php echo esc_attr(self::OPTION_RATE_LIMIT); ?>" value="<?php echo esc_attr((string) $rate_limit); ?>" /></td>
                    </tr>
                    <tr>
                        <th scope="row">Current token</th>
                        <td>
                            <code><?php echo $token ? esc_html(substr($token, 0, 8) . '...' . substr($token, -6)) : 'Not generated'; ?></code>
                        </td>
                    </tr>
                </table>
                <?php submit_button('Save Settings'); ?>
            </form>
            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                <?php wp_nonce_field('contentops_connector_regen_token'); ?>
                <input type="hidden" name="action" value="contentops_connector_regen_token" />
                <?php submit_button('Generate / Regenerate Token', 'secondary', 'submit', false); ?>
            </form>
            <?php if ($revealed_token !== ''): ?>
                <hr />
                <h2>New Token (shown once)</h2>
                <p>Copy this token now. It will be masked again after reload.</p>
                <input
                    id="contentops-full-token"
                    type="text"
                    readonly
                    style="width: 100%; max-width: 720px;"
                    value="<?php echo esc_attr($revealed_token); ?>"
                />
                <button type="button" class="button button-primary" id="contentops-copy-token" style="margin-left: 8px;">Copy Token</button>
                <script>
                    (function() {
                        const input = document.getElementById('contentops-full-token');
                        const button = document.getElementById('contentops-copy-token');
                        if (!input || !button) return;
                        button.addEventListener('click', async function() {
                            try {
                                await navigator.clipboard.writeText(input.value);
                                button.textContent = 'Copied';
                                setTimeout(() => { button.textContent = 'Copy Token'; }, 1500);
                            } catch (e) {
                                input.select();
                                document.execCommand('copy');
                                button.textContent = 'Copied';
                                setTimeout(() => { button.textContent = 'Copy Token'; }, 1500);
                            }
                        });
                    })();
                </script>
            <?php endif; ?>
        </div>
        <?php
    }

    public function handle_regenerate_token(): void {
        if (!current_user_can('manage_options')) {
            wp_die('Unauthorized');
        }
        check_admin_referer('contentops_connector_regen_token');
        $token = wp_generate_password(64, false, false);
        update_option(self::OPTION_TOKEN, $token, false);
        $user_id = get_current_user_id();
        if ($user_id) {
            set_transient(self::TRANSIENT_REVEAL_PREFIX . $user_id, $token, 5 * MINUTE_IN_SECONDS);
        }
        wp_safe_redirect(admin_url('options-general.php?page=contentops-connector'));
        exit;
    }

    public function register_rest_routes(): void {
        register_rest_route('contentops/v1', '/ping', [
            'methods' => WP_REST_Server::READABLE,
            'callback' => [$this, 'handle_ping'],
            'permission_callback' => [$this, 'authorize_request'],
        ]);

        register_rest_route('contentops/v1', '/publish', [
            'methods' => WP_REST_Server::CREATABLE,
            'callback' => [$this, 'handle_publish'],
            'permission_callback' => [$this, 'authorize_request'],
        ]);
    }

    public function maybe_send_cors_headers($served, $result, $request, $server) {
        if (!$request instanceof WP_REST_Request || strpos($request->get_route(), '/contentops/v1/') !== 0) {
            return $served;
        }
        $origin = isset($_SERVER['HTTP_ORIGIN']) ? sanitize_text_field(wp_unslash($_SERVER['HTTP_ORIGIN'])) : '';
        if (!$origin) {
            return $served;
        }
        $allowed = $this->get_allowed_origins();
        if (empty($allowed)) {
            return $served;
        }
        if (in_array($origin, $allowed, true)) {
            header('Access-Control-Allow-Origin: ' . esc_url_raw($origin));
            header('Access-Control-Allow-Headers: Content-Type, X-ContentOps-Token');
            header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
        }
        return $served;
    }

    public function authorize_request(WP_REST_Request $request) {
        if (!(bool) get_option(self::OPTION_ENABLED, true)) {
            return new WP_Error('contentops_disabled', 'Connector disabled', ['status' => 403]);
        }

        if (!$this->pass_rate_limit()) {
            return new WP_Error('contentops_rate_limited', 'Too many requests', ['status' => 429]);
        }

        $expected = (string) get_option(self::OPTION_TOKEN, '');
        $provided = (string) $request->get_header('X-ContentOps-Token');
        if (!$expected || !$provided || !hash_equals($expected, $provided)) {
            return new WP_Error('contentops_unauthorized', 'Invalid connector token', ['status' => 401]);
        }
        return true;
    }

    public function handle_ping(WP_REST_Request $request) {
        return rest_ensure_response([
            'ok' => true,
            'site_url' => site_url(),
            'wp_version' => get_bloginfo('version'),
            'max_upload_bytes' => wp_max_upload_size(),
            'supports' => ['publish', 'media', 'seo'],
        ]);
    }

    public function handle_publish(WP_REST_Request $request) {
        $params = $request->get_json_params();
        if (!is_array($params)) {
            return new WP_Error('invalid_payload', 'JSON body required', ['status' => 400]);
        }

        $title = isset($params['title']) ? wp_kses_post((string) $params['title']) : '';
        $content_html = isset($params['content_html']) ? (string) $params['content_html'] : '';
        $status = isset($params['status']) ? sanitize_key((string) $params['status']) : 'draft';
        $allowed_status = ['draft', 'publish', 'future'];
        if (!in_array($status, $allowed_status, true)) {
            $status = 'draft';
        }

        if (strlen($content_html) > 5 * 1024 * 1024) {
            return new WP_Error('content_too_large', 'content_html exceeds 5MB', ['status' => 413]);
        }

        $post_id = isset($params['post_id']) ? (int) $params['post_id'] : 0;
        $post_data = [
            'post_title' => $title,
            'post_content' => $content_html,
            'post_excerpt' => isset($params['excerpt']) ? sanitize_text_field((string) $params['excerpt']) : '',
            'post_name' => isset($params['slug']) ? sanitize_title((string) $params['slug']) : '',
            'post_status' => $status,
            'post_type' => 'post',
        ];
        if (!empty($params['author'])) {
            $post_data['post_author'] = (int) $params['author'];
        }
        if (!empty($params['date_gmt'])) {
            $post_data['post_date_gmt'] = sanitize_text_field((string) $params['date_gmt']);
        }

        if ($post_id > 0 && get_post($post_id)) {
            $post_data['ID'] = $post_id;
            $post_id = wp_update_post($post_data, true);
        } else {
            $post_id = wp_insert_post($post_data, true);
        }
        if (is_wp_error($post_id)) {
            return new WP_Error('post_write_failed', $post_id->get_error_message(), ['status' => 500]);
        }

        $uploaded_inline = [];
        $featured_media_id = 0;
        $mutated_content = (string) $post_data['post_content'];

        if (!empty($params['featured_image']) && is_array($params['featured_image'])) {
            $result = $this->ingest_image($params['featured_image'], 'contentops-featured');
            if (is_wp_error($result)) {
                return $result;
            }
            $featured_media_id = (int) $result['attachment_id'];
            set_post_thumbnail($post_id, $featured_media_id);
            if (!empty($params['featured_image']['alt'])) {
                update_post_meta($featured_media_id, '_wp_attachment_image_alt', sanitize_text_field((string) $params['featured_image']['alt']));
            }
        }

        if (!empty($params['inline_images']) && is_array($params['inline_images'])) {
            foreach ($params['inline_images'] as $item) {
                if (!is_array($item)) {
                    continue;
                }
                $match_src = isset($item['match_src']) ? (string) $item['match_src'] : '';
                if (!$match_src) {
                    continue;
                }
                $result = $this->ingest_image($item, 'contentops-inline');
                if (is_wp_error($result)) {
                    return $result;
                }
                $new_url = (string) $result['url'];
                $mutated_content = str_replace($match_src, $new_url, $mutated_content);
                if (!empty($item['alt'])) {
                    update_post_meta((int) $result['attachment_id'], '_wp_attachment_image_alt', sanitize_text_field((string) $item['alt']));
                }
                $uploaded_inline[] = [
                    'from' => $match_src,
                    'to' => $new_url,
                    'attachment_id' => (int) $result['attachment_id'],
                ];
            }
        }

        if ($mutated_content !== $post_data['post_content']) {
            wp_update_post([
                'ID' => $post_id,
                'post_content' => $mutated_content,
            ]);
        }

        $term_result = $this->assign_terms($post_id, $params);
        if (is_wp_error($term_result)) {
            return $term_result;
        }

        $seo_written = $this->write_seo_meta($post_id, $params);
        $this->write_custom_meta($post_id, $params);

        return rest_ensure_response([
            'ok' => true,
            'post_id' => $post_id,
            'permalink' => get_permalink($post_id),
            'edit_url' => get_edit_post_link($post_id, ''),
            'featured_media_id' => $featured_media_id ?: null,
            'uploaded_inline' => $uploaded_inline,
            'seo_written' => $seo_written,
        ]);
    }

    private function assign_terms(int $post_id, array $params) {
        if (!empty($params['categories']) && is_array($params['categories'])) {
            $category_ids = [];
            foreach ($params['categories'] as $cat) {
                if (is_numeric($cat)) {
                    $category_ids[] = (int) $cat;
                    continue;
                }
                $name = sanitize_text_field((string) $cat);
                if (!$name) {
                    continue;
                }
                $term = term_exists($name, 'category');
                if (!$term) {
                    $created = wp_insert_term($name, 'category');
                    if (is_wp_error($created)) {
                        continue;
                    }
                    $category_ids[] = (int) $created['term_id'];
                } else {
                    $category_ids[] = (int) (is_array($term) ? $term['term_id'] : $term);
                }
            }
            if (!empty($category_ids)) {
                wp_set_post_terms($post_id, $category_ids, 'category');
            }
        }

        if (!empty($params['tags']) && is_array($params['tags'])) {
            $tag_ids = [];
            foreach ($params['tags'] as $tag) {
                if (is_numeric($tag)) {
                    $tag_ids[] = (int) $tag;
                    continue;
                }
                $name = sanitize_text_field((string) $tag);
                if (!$name) {
                    continue;
                }
                $term = term_exists($name, 'post_tag');
                if (!$term) {
                    $created = wp_insert_term($name, 'post_tag');
                    if (is_wp_error($created)) {
                        continue;
                    }
                    $tag_ids[] = (int) $created['term_id'];
                } else {
                    $tag_ids[] = (int) (is_array($term) ? $term['term_id'] : $term);
                }
            }
            if (!empty($tag_ids)) {
                wp_set_post_terms($post_id, $tag_ids, 'post_tag');
            }
        }
        return true;
    }

    private function write_seo_meta(int $post_id, array $params): array {
        $seo = isset($params['seo']) && is_array($params['seo']) ? $params['seo'] : [];
        $meta_title = isset($seo['meta_title']) ? sanitize_text_field((string) $seo['meta_title']) : '';
        $meta_description = isset($seo['meta_description']) ? sanitize_text_field((string) $seo['meta_description']) : '';
        $focus_keyphrase = isset($seo['focus_keyphrase']) ? sanitize_text_field((string) $seo['focus_keyphrase']) : '';
        $canonical = isset($seo['canonical']) ? esc_url_raw((string) $seo['canonical']) : '';
        $robots = isset($seo['robots']) ? sanitize_text_field((string) $seo['robots']) : '';

        $yoast = false;
        $rankmath = false;

        if ($meta_title !== '') {
            update_post_meta($post_id, '_yoast_wpseo_title', $meta_title);
            update_post_meta($post_id, 'rank_math_title', $meta_title);
            update_post_meta($post_id, '_aioseo_title', $meta_title);
            $yoast = true;
            $rankmath = true;
        }
        if ($meta_description !== '') {
            update_post_meta($post_id, '_yoast_wpseo_metadesc', $meta_description);
            update_post_meta($post_id, 'rank_math_description', $meta_description);
            update_post_meta($post_id, '_aioseo_description', $meta_description);
            $yoast = true;
            $rankmath = true;
        }
        if ($focus_keyphrase !== '') {
            update_post_meta($post_id, '_yoast_wpseo_focuskw', $focus_keyphrase);
            update_post_meta($post_id, 'rank_math_focus_keyword', $focus_keyphrase);
            update_post_meta($post_id, 'contentops_focus_keyphrase', $focus_keyphrase);
            $yoast = true;
            $rankmath = true;
        }
        if ($canonical !== '') {
            update_post_meta($post_id, '_yoast_wpseo_canonical', $canonical);
            update_post_meta($post_id, 'rank_math_canonical_url', $canonical);
            $yoast = true;
            $rankmath = true;
        }
        if ($robots !== '') {
            $noindex = stripos($robots, 'noindex') !== false ? '1' : '0';
            $nofollow = stripos($robots, 'nofollow') !== false ? '1' : '0';
            update_post_meta($post_id, '_yoast_wpseo_meta-robots-noindex', $noindex);
            update_post_meta($post_id, '_yoast_wpseo_meta-robots-nofollow', $nofollow);
            update_post_meta($post_id, 'rank_math_robots', $robots);
            $yoast = true;
            $rankmath = true;
        }
        return ['yoast' => $yoast, 'rankmath' => $rankmath];
    }

    private function write_custom_meta(int $post_id, array $params): void {
        if (!empty($params['meta']) && is_array($params['meta'])) {
            foreach ($params['meta'] as $key => $value) {
                $meta_key = sanitize_key((string) $key);
                if (!$meta_key || is_array($value) || is_object($value)) {
                    continue;
                }
                update_post_meta($post_id, $meta_key, sanitize_text_field((string) $value));
            }
        }
        if (!empty($params['seo']) && is_array($params['seo'])) {
            $seo = $params['seo'];
            if (isset($seo['meta_title'])) {
                update_post_meta($post_id, 'contentops_meta_title', sanitize_text_field((string) $seo['meta_title']));
            }
            if (isset($seo['meta_description'])) {
                update_post_meta($post_id, 'contentops_meta_description', sanitize_text_field((string) $seo['meta_description']));
            }
        }
    }

    private function ingest_image(array $descriptor, string $prefix) {
        if (empty($descriptor['source'])) {
            return new WP_Error('image_source_missing', 'Image source is required', ['status' => 400]);
        }
        $source = sanitize_key((string) $descriptor['source']);
        $filename = !empty($descriptor['filename']) ? sanitize_file_name((string) $descriptor['filename']) : ($prefix . '-' . wp_generate_password(8, false, false) . '.jpg');
        $tmp = '';

        if ($source === 'url') {
            if (empty($descriptor['url'])) {
                return new WP_Error('image_url_missing', 'Image URL is required', ['status' => 400]);
            }
            $url = esc_url_raw((string) $descriptor['url']);
            $tmp = download_url($url, 20);
            if (is_wp_error($tmp)) {
                return new WP_Error('image_download_failed', $tmp->get_error_message(), ['status' => 400]);
            }
        } elseif ($source === 'base64') {
            if (empty($descriptor['base64'])) {
                return new WP_Error('image_base64_missing', 'Image base64 is required', ['status' => 400]);
            }
            $decoded = base64_decode((string) $descriptor['base64'], true);
            if ($decoded === false) {
                return new WP_Error('image_base64_invalid', 'Invalid image base64', ['status' => 400]);
            }
            if (strlen($decoded) > wp_max_upload_size()) {
                return new WP_Error('image_too_large', 'Image exceeds max upload size', ['status' => 413]);
            }
            $tmp = wp_tempnam($filename);
            if (!$tmp) {
                return new WP_Error('image_temp_failed', 'Unable to create temp file', ['status' => 500]);
            }
            file_put_contents($tmp, $decoded);
        } else {
            return new WP_Error('image_source_invalid', 'source must be url or base64', ['status' => 400]);
        }

        $file_array = [
            'name' => $filename,
            'tmp_name' => $tmp,
        ];
        $this->load_media_dependencies();
        $attachment_id = media_handle_sideload($file_array, 0);
        if (is_wp_error($attachment_id)) {
            if (file_exists($tmp)) {
                @unlink($tmp);
            }
            return new WP_Error('image_upload_failed', $attachment_id->get_error_message(), ['status' => 500]);
        }
        $url = wp_get_attachment_url($attachment_id);
        return [
            'attachment_id' => (int) $attachment_id,
            'url' => $url ?: '',
        ];
    }

    private function load_media_dependencies(): void {
        if (!function_exists('media_handle_sideload')) {
            require_once ABSPATH . 'wp-admin/includes/media.php';
        }
        if (!function_exists('wp_handle_sideload')) {
            require_once ABSPATH . 'wp-admin/includes/file.php';
        }
        if (!function_exists('wp_generate_attachment_metadata')) {
            require_once ABSPATH . 'wp-admin/includes/image.php';
        }
    }

    private function pass_rate_limit(): bool {
        $ip = isset($_SERVER['REMOTE_ADDR']) ? sanitize_text_field(wp_unslash($_SERVER['REMOTE_ADDR'])) : 'unknown';
        $key = 'contentops_rate_' . md5($ip);
        $limit = (int) get_option(self::OPTION_RATE_LIMIT, 60);
        $count = (int) get_transient($key);
        if ($count >= $limit) {
            return false;
        }
        set_transient($key, $count + 1, MINUTE_IN_SECONDS);
        return true;
    }

    private function get_allowed_origins(): array {
        $raw = (string) get_option(self::OPTION_ALLOWED_ORIGINS, '');
        if (!$raw) {
            return [];
        }
        $lines = preg_split('/\r\n|\r|\n/', $raw) ?: [];
        $out = [];
        foreach ($lines as $line) {
            $value = trim($line);
            if (!$value) {
                continue;
            }
            $out[] = $value;
        }
        return array_values(array_unique($out));
    }
}

new ContentOpsConnector();
