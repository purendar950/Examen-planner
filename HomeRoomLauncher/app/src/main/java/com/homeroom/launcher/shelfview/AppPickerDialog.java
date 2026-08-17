package com.homeroom.launcher.shelfview;

import android.app.AlertDialog;
import android.content.Context;
import android.graphics.drawable.ColorDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.BaseAdapter;
import android.widget.GridView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;

/** Grid of installed launchable apps shown when assigning a shelf slot. */
public final class AppPickerDialog {

    public interface OnAppPickedListener {
        void onAppPicked(String packageName);
    }

    public static void show(Context ctx, final OnAppPickedListener listener) {
        final List<IconCache.Entry> apps = IconCache.getLaunchables(ctx);

        GridView grid = new GridView(ctx);
        grid.setNumColumns(4);
        grid.setStretchMode(GridView.STRETCH_COLUMN_WIDTH);
        grid.setVerticalSpacing(dp(ctx, 12));
        grid.setHorizontalSpacing(dp(ctx, 8));
        grid.setPadding(dp(ctx, 16), dp(ctx, 16), dp(ctx, 16), dp(ctx, 16));
        grid.setSelector(new ColorDrawable(0x22FFFFFF));
        grid.setAdapter(new AppAdapter(ctx, apps));

        final AlertDialog dlg = new AlertDialog.Builder(ctx)
                .setTitle("Choose an app")
                .setView(grid)
                .setNegativeButton(android.R.string.cancel, null)
                .create();

        grid.setOnItemClickListener(new AdapterView.OnItemClickListener() {
            @Override public void onItemClick(AdapterView<?> parent, View view, int position, long id) {
                listener.onAppPicked(apps.get(position).packageName);
                dlg.dismiss();
            }
        });

        dlg.show();
        if (dlg.getWindow() != null) {
            dlg.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, dp(ctx, 420));
        }
    }

    private static int dp(Context ctx, int v) {
        return (int) (ctx.getResources().getDisplayMetrics().density * v + 0.5f);
    }

    private static final class AppAdapter extends BaseAdapter {
        private final Context ctx;
        private final List<IconCache.Entry> apps;
        private final int iconSize;

        AppAdapter(Context ctx, List<IconCache.Entry> apps) {
            this.ctx = ctx;
            this.apps = apps;
            this.iconSize = dp(ctx, 56);
        }

        @Override public int getCount() { return apps.size(); }
        @Override public Object getItem(int position) { return apps.get(position); }
        @Override public long getItemId(int position) { return position; }

        @Override public View getView(int position, View convertView, ViewGroup parent) {
            if (convertView == null) {
                LinearLayout row = new LinearLayout(ctx);
                row.setOrientation(LinearLayout.VERTICAL);
                row.setGravity(Gravity.CENTER_HORIZONTAL);
                row.setPadding(0, dp(ctx, 8), 0, dp(ctx, 8));

                ImageView icon = new ImageView(ctx);
                icon.setLayoutParams(new LinearLayout.LayoutParams(iconSize, iconSize));
                row.addView(icon);

                TextView label = new TextView(ctx);
                label.setSingleLine(true);
                label.setEllipsize(TextUtils.TruncateAt.END);
                label.setTextSize(11);
                label.setTextColor(0xFFFFFFFF);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                lp.topMargin = dp(ctx, 4);
                label.setLayoutParams(lp);
                row.addView(label);

                row.setTag(new ViewHolder(icon, label));
                convertView = row;
            }

            ViewHolder h = (ViewHolder) convertView.getTag();
            IconCache.Entry e = apps.get(position);
            h.icon.setImageDrawable(e.icon);
            h.label.setText(e.label);
            return convertView;
        }

        private static final class ViewHolder {
            final ImageView icon;
            final TextView label;
            ViewHolder(ImageView i, TextView l) { icon = i; label = l; }
        }
    }
}
