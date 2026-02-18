import csv
import re
import os

INPUT_FILE = 'DataSet.csv'
OUTPUT_FILE = 'DataSet.csv'

def get_label(filename):
    if not filename:
        return ""
    if "colocated" in filename.lower():
        return "Co-location"
    
    # Extract distance like "4m", "10m"
    match = re.search(r'_(\d+m)\.', filename)
    if match:
        return match.group(1)
    
    return filename

def migrate():
    if not os.path.exists(INPUT_FILE):
        print(f"Error: {INPUT_FILE} not found.")
        return

    with open(INPUT_FILE, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames)
        rows = list(reader)

    # Find IR pairs and insert Label columns
    new_fieldnames = []
    
    # We want to insert IR_Label_X right after IR_Rotation_X
    # Scan headers
    processed_indices = set()
    
    base_fieldnames = []
    ir_groups = {} # { 1: {name: col, rot: col, label: col} }

    # First pass: identify fields
    for col in fieldnames:
        if col.startswith("IR_Name_"):
            idx = col.replace("IR_Name_", "")
            if idx not in ir_groups: ir_groups[idx] = {}
            ir_groups[idx]['name'] = col
        elif col.startswith("IR_Rotation_"):
            idx = col.replace("IR_Rotation_", "")
            if idx not in ir_groups: ir_groups[idx] = {}
            ir_groups[idx]['rot'] = col
        else:
            base_fieldnames.append(col)

    # Reconstruct fieldnames order
    final_fieldnames = []
    
    # Add non-IR columns until we hit the first IR column? 
    # Actually, DataSet has fixed order usually. Let's just iterate original and insert.
    
    for col in fieldnames:
        final_fieldnames.append(col)
        if col.startswith("IR_Rotation_"):
            idx = col.replace("IR_Rotation_", "")
            label_col = f"IR_Label_{idx}"
            if label_col not in final_fieldnames:
                final_fieldnames.append(label_col)

    print(f"New Columns: {final_fieldnames}")

    # Process Rows
    for row in rows:
        for key in list(row.keys()):
            if key.startswith("IR_Name_"):
                idx = key.replace("IR_Name_", "")
                label_key = f"IR_Label_{idx}"
                row[label_key] = get_label(row[key])

    # Write back
    with open(OUTPUT_FILE, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=final_fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    
    print("✅ DataSet.csv updated with IR Labels.")

if __name__ == "__main__":
    migrate()
