"""Standard-library API client; no TradeCase database access or automatic approval."""
import base64
import json
import urllib.request

BASE = 'http://127.0.0.1:4310/v1'
def request(route, payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + route, body, {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)

def prepare(case_id, product_id, requirements, image_path):
    project = request('/projects', {'name': 'Buyer proposal ' + case_id, 'product_id': product_id})
    with open(image_path, 'rb') as image:
        source = request('/assets/import', {
            'project_id': project['id'], 'filename': 'product.png',
            'data_base64': base64.b64encode(image.read()).decode(), 'kind': 'product_photo',
            # The caller must obtain these attestations from the responsible owner.
            'authorized': True, 'verified': True, 'sensitive_data_cleared': True,
        })
    brief = request('/briefs', {
        'project_id': project['id'], 'workflow': 'buyer-proposal',
        'source': {'system': 'tradecase', 'external_id': case_id},
        'requirements': requirements, 'intent': 'product-display',
        'product': {'product_id': product_id, 'stage': 'existing_sku'},
        'reference_asset_ids': [source['id']], 'variants': 1, 'provider': 'mock',
        'delivery_target': 'buyer_review',
    })
    return request('/briefs/' + brief['id'] + '/plan', {})

def queue_approved_plan(plan_id, case_id):
    return request('/batches', {'plan_id': plan_id, 'budget_usd': 0,
        'authorize_paid': False, 'idempotency_key': case_id + ':' + plan_id})

def status(batch_id):
    return request('/batches/' + batch_id)
